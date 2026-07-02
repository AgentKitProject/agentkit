// UserSettingsStore — per-user server-side settings for Web Forge.
//
// The desktop app keeps AI provider configs (including API keys) in a local
// settings.json. The web build has no per-user local FS, so settings live
// server-side, scoped to the authenticated user's id, alongside the KitStore
// (same data dir / adapter story).
//
// SECRETS-AT-REST: provider API keys are SECRETS. When AGENTKITFORGE_WEB_SECRET
// is set (a 32-byte key, hex or base64, or any passphrase), keys are encrypted
// with AES-256-GCM before being written to disk and decrypted on read. When it
// is NOT set, keys are stored in PLAINTEXT and a one-time warning is logged.
// TODO(secrets): in hosted/self-host adapters, source the secret from a KMS /
// secrets manager and consider per-tenant keys.
//
// The GET surface NEVER returns secrets: list views report `hasApiKey` only.
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { assertProviderAllowed } from "@/server/store/provider-lock";

function dataDir(): string {
  return process.env.AGENTKITFORGE_WEB_DATA_DIR || path.resolve(process.cwd(), ".agentkitforge-data");
}

function assertSafeSegment(segment: string, label: string): void {
  if (
    !segment ||
    segment.includes("\0") ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment === "." ||
    segment === ".."
  ) {
    throw new Error(`Invalid ${label}.`);
  }
}

function settingsFile(userId: string): string {
  assertSafeSegment(userId, "userId");
  return path.join(dataDir(), "users", userId, "settings.json");
}

// --- at-rest encryption ------------------------------------------------------

let warnedNoSecret = false;

function secretKey(): Buffer | null {
  const raw = process.env.AGENTKITFORGE_WEB_SECRET;
  if (!raw) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[user-settings] AGENTKITFORGE_WEB_SECRET is not set — AI provider API keys are stored in PLAINTEXT. Set it to enable AES-256-GCM at-rest encryption."
      );
    }
    return null;
  }
  // Accept a raw 32-byte hex/base64 key, else derive a stable key from the passphrase.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;
  return crypto.createHash("sha256").update(raw).digest();
}

const ENC_PREFIX = "enc:v1:";

function encryptSecret(plain: string): string {
  const key = secretKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored; // plaintext (legacy / no secret)
  const key = secretKey();
  if (!key) throw new Error("Stored API key is encrypted but AGENTKITFORGE_WEB_SECRET is not set.");
  const [, , ivB64, tagB64, dataB64] = stored.split(":");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// --- shapes ------------------------------------------------------------------
// Canonical shapes live in settings-types.ts so every adapter shares them; the
// disk adapter re-exports them for backward-compatible imports from this module.
export type {
  StoredProvider,
  UserSettings,
  PublicProvider
} from "@/server/store/settings-types";
import type {
  PublicProvider,
  StoredProvider,
  UserSettings,
  UserSettingsStore as UserSettingsStoreInterface
} from "@/server/store/settings-types";

const EMPTY: UserSettings = { providers: [] };

async function readSettings(userId: string): Promise<UserSettings> {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsFile(userId), "utf8")) as UserSettings;
    return { providers: parsed.providers ?? [], defaultProviderId: parsed.defaultProviderId, preferences: parsed.preferences };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
    throw error;
  }
}

async function writeSettings(userId: string, settings: UserSettings): Promise<void> {
  const file = settingsFile(userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function toPublicProvider(p: StoredProvider): PublicProvider {
  const { apiKey, ...rest } = p;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}

export class DiskUserSettingsStore implements UserSettingsStoreInterface {
  async getPublic(userId: string): Promise<{ providers: PublicProvider[]; defaultProviderId?: string; preferences?: Record<string, unknown> }> {
    const s = await readSettings(userId);
    return { providers: s.providers.map(toPublicProvider), defaultProviderId: s.defaultProviderId, preferences: s.preferences };
  }

  /** Add or update a provider. If `apiKey` is omitted on an update, keep the existing key. */
  async saveProvider(
    userId: string,
    input: {
      id?: string;
      name: string;
      providerType: StoredProvider["providerType"];
      baseUrl?: string;
      defaultModel?: string;
      supportsStructuredJson?: boolean;
      apiKey?: string;
    }
  ): Promise<PublicProvider> {
    assertProviderAllowed(input.providerType);
    const s = await readSettings(userId);
    const now = new Date().toISOString();
    const id = input.id?.trim() || crypto.randomUUID();
    const existing = s.providers.find((p) => p.id === id);
    const apiKey =
      input.apiKey && input.apiKey.trim()
        ? encryptSecret(input.apiKey.trim())
        : existing?.apiKey;
    const record: StoredProvider = {
      id,
      name: input.name.trim() || input.providerType,
      providerType: input.providerType,
      baseUrl: input.baseUrl?.trim() || undefined,
      defaultModel: input.defaultModel?.trim() || undefined,
      supportsStructuredJson: input.supportsStructuredJson,
      apiKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    s.providers = [...s.providers.filter((p) => p.id !== id), record];
    if (!s.defaultProviderId) s.defaultProviderId = id;
    await writeSettings(userId, s);
    return toPublicProvider(record);
  }

  async removeProvider(userId: string, providerId: string): Promise<void> {
    const s = await readSettings(userId);
    s.providers = s.providers.filter((p) => p.id !== providerId);
    if (s.defaultProviderId === providerId) s.defaultProviderId = s.providers[0]?.id;
    await writeSettings(userId, s);
  }

  async setPreferences(userId: string, preferences: Record<string, unknown>): Promise<void> {
    const s = await readSettings(userId);
    s.preferences = { ...(s.preferences ?? {}), ...preferences };
    await writeSettings(userId, s);
  }

  async setDefault(userId: string, providerId: string): Promise<void> {
    const s = await readSettings(userId);
    if (!s.providers.some((p) => p.id === providerId)) throw new Error("Unknown provider id.");
    s.defaultProviderId = providerId;
    await writeSettings(userId, s);
  }

  /**
   * Resolve a usable provider config (WITH decrypted key) for an AI operation.
   * Falls back to the default provider when no id is given. Returns null when
   * the user has configured no providers.
   */
  async resolveProvider(userId: string, providerId?: string): Promise<(StoredProvider & { apiKey?: string }) | null> {
    const s = await readSettings(userId);
    const chosen =
      (providerId && s.providers.find((p) => p.id === providerId)) ||
      (s.defaultProviderId && s.providers.find((p) => p.id === s.defaultProviderId)) ||
      s.providers[0];
    if (!chosen) return null;
    return { ...chosen, apiKey: chosen.apiKey ? decryptSecret(chosen.apiKey) : undefined };
  }
}

/** @deprecated Back-compat alias for the disk adapter class. */
export const UserSettingsStore = DiskUserSettingsStore;

// Adapter selection (local | aws | selfhost) lives in server/store/index.ts.
// Re-exported here so existing callers keep importing getUserSettingsStore from
// this module; it is now ASYNC because cloud adapters build clients lazily.
export { getUserSettingsStore } from "@/server/store/index";
