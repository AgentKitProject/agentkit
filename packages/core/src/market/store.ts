/**
 * Cross-platform CLI default {@link TokenStore}.
 *
 * Strategy (per the workspace CLAUDE.md token-storage design):
 *  1. Try the OS keyring via the OPTIONAL native module `@napi-rs/keyring`,
 *     loaded by a lazy dynamic import so core stays `npm install`-clean even
 *     where the native module is unavailable (headless Linux/CI).
 *  2. MANDATORY fallback: a `0600` JSON file in the platform config dir under an
 *     `agentkitforge/` subdir. The file fallback is required because headless
 *     Linux/CI has no Secret Service.
 *
 * Naming (`SERVICE_NAME` / `SESSION_ACCOUNT`) is kept identical to the Rust
 * `secure_storage.rs` so the app and CLI interoperate on per-user OS stores
 * where the platform allows (Windows Credential Manager / Linux Secret Service).
 * On macOS the Keychain ACL is per-binary, so app↔CLI sharing is NOT guaranteed
 * there — by design the app keeps Keychain access in Rust.
 *
 * Tokens are secrets: this module never logs `accessToken`/`refreshToken`.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { StoredSession, TokenStore } from "./types.js";

/** Matches `secure_storage.rs::SERVICE_NAME` for app↔CLI interop. */
export const SERVICE_NAME = "com.agentkitforge.desktop.agentkitproject";
/** Matches `secure_storage.rs::SESSION_ACCOUNT`. */
export const SESSION_ACCOUNT = "agentkitproject-session";

/** Resolve the platform config dir, never hardcoding `~`. */
export function configDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData && appData.trim() !== "") {
      return path.join(appData, "agentkitforge");
    }
    return path.join(os.homedir(), "AppData", "Roaming", "agentkitforge");
  }
  if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "agentkitforge"
    );
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== "") {
    return path.join(xdg, "agentkitforge");
  }
  return path.join(os.homedir(), ".config", "agentkitforge");
}

function sessionFilePath(dir: string): string {
  return path.join(dir, "session.json");
}

/**
 * Validate and normalize a parsed session. Returns `null` for an empty/invalid
 * access token (treated as "no session"), matching the Rust readback checks.
 */
function normalizeSession(raw: unknown): StoredSession | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const accessToken =
    typeof r.accessToken === "string" ? r.accessToken.trim() : "";
  if (accessToken === "") return null;
  const session: StoredSession = {
    accessToken,
    connectedAt:
      typeof r.connectedAt === "string" ? r.connectedAt : new Date().toISOString()
  };
  if (typeof r.refreshToken === "string" && r.refreshToken.trim() !== "") {
    session.refreshToken = r.refreshToken;
  }
  if (typeof r.user === "object" && r.user !== null) {
    session.user = r.user as StoredSession["user"];
  }
  return session;
}

/**
 * Lazily attempt to load `@napi-rs/keyring`. Returns `null` when the optional
 * dependency is not installed/usable so we fall back to the file store cleanly.
 */
async function tryLoadKeyringEntry(): Promise<{
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
} | null> {
  try {
    // Dynamic + indirected so bundlers/`tsc` don't treat it as a hard dep.
    const moduleName = "@napi-rs/keyring";
    const mod: unknown = await import(/* @vite-ignore */ moduleName);
    const Entry = (mod as { Entry?: unknown }).Entry;
    if (typeof Entry !== "function") return null;
    const EntryCtor = Entry as new (
      service: string,
      account: string
    ) => {
      getPassword(): string | null;
      setPassword(password: string): void;
      deletePassword(): boolean;
    };
    return new EntryCtor(SERVICE_NAME, SESSION_ACCOUNT);
  } catch {
    return null;
  }
}

export interface FileTokenStoreOptions {
  /** Override the config dir (used by tests with a temp dir). */
  dir?: string;
  /**
   * When `false`, skip the OS keyring entirely and use only the file store.
   * Defaults to `true`. Tests use `false` to exercise the file path
   * deterministically.
   */
  useKeyring?: boolean;
}

/**
 * The default cross-platform CLI store: OS keyring (optional) → `0600` file.
 */
export class FileTokenStore implements TokenStore {
  private readonly dir: string;
  private readonly useKeyring: boolean;

  constructor(options: FileTokenStoreOptions = {}) {
    this.dir = options.dir ?? configDir();
    this.useKeyring = options.useKeyring ?? true;
  }

  async get(): Promise<StoredSession | null> {
    if (this.useKeyring) {
      const entry = await tryLoadKeyringEntry();
      if (entry) {
        try {
          const secret = entry.getPassword();
          if (secret) return normalizeSession(JSON.parse(secret));
          // Keyring reachable but empty → fall through to file (migration safe).
        } catch {
          // Keyring read failed → fall back to file.
        }
      }
    }
    return this.readFile();
  }

  async set(session: StoredSession): Promise<void> {
    const json = JSON.stringify(session);
    if (this.useKeyring) {
      const entry = await tryLoadKeyringEntry();
      if (entry) {
        try {
          entry.setPassword(json);
          return;
        } catch {
          // Keyring write failed → persist to file instead.
        }
      }
    }
    await this.writeFile(json);
  }

  async clear(): Promise<void> {
    if (this.useKeyring) {
      const entry = await tryLoadKeyringEntry();
      if (entry) {
        try {
          entry.deletePassword();
        } catch {
          // ignore: best-effort keyring clear
        }
      }
    }
    await this.removeFile();
  }

  private async readFile(): Promise<StoredSession | null> {
    try {
      const raw = await fs.readFile(sessionFilePath(this.dir), "utf8");
      return normalizeSession(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private async writeFile(json: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = sessionFilePath(this.dir);
    // Write with restrictive perms; also chmod in case the file pre-existed
    // with looser perms (umask can widen the create mode).
    await fs.writeFile(file, json, { mode: 0o600 });
    await fs.chmod(file, 0o600).catch(() => {});
  }

  private async removeFile(): Promise<void> {
    await fs.rm(sessionFilePath(this.dir), { force: true });
  }
}

/** Construct the default CLI token store. */
export function createDefaultTokenStore(
  options?: FileTokenStoreOptions
): TokenStore {
  return new FileTokenStore(options);
}
