// Phase 2 — BYO Anthropic key flow (server/core/auto-byo.ts).
//
// Covers, in test-mode only (no real Anthropic / no network):
//   - the key is stored ENCRYPTED at rest (the settings file never contains the
//     plaintext key) when AGENTKITFORGE_WEB_SECRET is set;
//   - getByoKeyStatus reports hasKey + the inference-mode preference (secret-free);
//   - key-format validation rejects non-Anthropic / malformed keys WITHOUT ever
//     echoing the key in the error;
//   - clearByoKey removes the key;
//   - the inference-mode preference round-trips.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_ENV = { ...process.env };
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "auto-byo-test-"));
  process.env.KITSTORE_BACKEND = "local";
  process.env.AGENTKITFORGE_WEB_DATA_DIR = dataDir;
  // A 32-byte hex secret → AES-256-GCM at-rest encryption.
  process.env.AGENTKITFORGE_WEB_SECRET = "a".repeat(64);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

const USER = "user-1";
const KEY = "sk-ant-api03-THISISATESTKEY1234567890";

function settingsFileText(): string {
  return readFileSync(join(dataDir, "users", USER, "settings.json"), "utf8");
}

describe("validateAnthropicKeyFormat", () => {
  it("rejects malformed keys without echoing the key", async () => {
    const { validateAnthropicKeyFormat, ByoKeyValidationError } = await import("@/server/core/auto-byo");
    for (const bad of ["", "   ", "sk-openai-xxxx", "sk-ant-x", "sk-ant- with space"]) {
      let thrown: unknown;
      try {
        validateAnthropicKeyFormat(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ByoKeyValidationError);
      expect((thrown as Error).message).not.toContain(bad.trim() || "∅");
    }
  });

  it("accepts a well-formed Anthropic key (trimmed)", async () => {
    const { validateAnthropicKeyFormat } = await import("@/server/core/auto-byo");
    expect(validateAnthropicKeyFormat(`  ${KEY}  `)).toBe(KEY);
  });
});

describe("setByoKey / getByoKeyStatus", () => {
  it("stores the key ENCRYPTED at rest (no plaintext on disk)", async () => {
    const { setByoKey, getByoKeyStatus } = await import("@/server/core/auto-byo");
    const status = await setByoKey(USER, { apiKey: KEY });
    expect(status.hasKey).toBe(true);

    const raw = settingsFileText();
    // The plaintext key must NOT appear; the stored value is the enc:v1: blob.
    expect(raw).not.toContain(KEY);
    expect(raw).toContain("enc:v1:");

    // Status never leaks the key.
    const fetched = await getByoKeyStatus(USER);
    expect(JSON.stringify(fetched)).not.toContain(KEY);
    expect(fetched.hasKey).toBe(true);
  });

  it("the well-known BYO provider resolves the DECRYPTED key for billing", async () => {
    const { setByoKey, byoProviderId } = await import("@/server/core/auto-byo");
    await setByoKey(USER, { apiKey: KEY });
    const { getUserSettingsStore } = await import("@/server/store/user-settings");
    const resolved = await (await getUserSettingsStore()).resolveProvider(USER, byoProviderId());
    expect(resolved?.providerType).toBe("anthropic");
    expect(resolved?.apiKey).toBe(KEY); // decrypted round-trip
  });

  it("the inference-mode preference round-trips and defaults to auto", async () => {
    const { setByoKey, getByoKeyStatus, getInferenceModePreference } = await import(
      "@/server/core/auto-byo"
    );
    expect((await getByoKeyStatus(USER)).inferenceMode).toBe("auto");
    await setByoKey(USER, { inferenceMode: "managed" });
    expect(await getInferenceModePreference(USER)).toBe("managed");
    await setByoKey(USER, { inferenceMode: "byo" });
    expect((await getByoKeyStatus(USER)).inferenceMode).toBe("byo");
  });

  it("clearByoKey removes the key", async () => {
    const { setByoKey, clearByoKey, getByoKeyStatus } = await import("@/server/core/auto-byo");
    await setByoKey(USER, { apiKey: KEY });
    expect((await getByoKeyStatus(USER)).hasKey).toBe(true);
    const after = await clearByoKey(USER);
    expect(after.hasKey).toBe(false);
  });
});
