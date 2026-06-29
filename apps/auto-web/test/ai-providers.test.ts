// Generalized BYO provider manager (the store path behind
// /api/auto/ai-providers). Verifies, in test-mode only (no real provider / no
// network), that a user can configure a provider of ANY of the 5 types, that the
// default selection flows to run-resolution, that keys are encrypted at rest, and
// that the ALLOWED_PROVIDERS provider-lock is enforced server-side.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_ENV = { ...process.env };
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "auto-ai-providers-test-"));
  process.env.KITSTORE_BACKEND = "local";
  process.env.AGENTKITFORGE_WEB_DATA_DIR = dataDir;
  process.env.AGENTKITFORGE_WEB_SECRET = "b".repeat(64); // AES-256-GCM at rest
  delete process.env.ALLOWED_PROVIDERS;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

const USER = "user-1";

function settingsText(): string {
  return readFileSync(join(dataDir, "users", USER, "settings.json"), "utf8");
}

describe("ai-providers store path (generalized BYO)", () => {
  it("saves a NON-Anthropic provider; its key is encrypted at rest and run-resolution reads it", async () => {
    const { getUserSettingsStore } = await import("@/server/store/user-settings");
    const store = await getUserSettingsStore();
    const OPENAI_KEY = "sk-openai-THISISATESTKEY1234567890";
    await store.saveProvider(USER, {
      name: "My OpenAI",
      providerType: "openai",
      defaultModel: "gpt-4o-mini",
      apiKey: OPENAI_KEY
    });

    // Encrypted at rest: plaintext key absent, enc blob present.
    const raw = settingsText();
    expect(raw).not.toContain(OPENAI_KEY);
    expect(raw).toContain("enc:v1:");

    // Public view never leaks the key.
    const pub = await store.getPublic(USER);
    expect(JSON.stringify(pub)).not.toContain(OPENAI_KEY);
    expect(pub.providers[0].providerType).toBe("openai");
    expect(pub.providers[0].hasApiKey).toBe(true);

    // First saved provider becomes the default → run-resolution (no providerId)
    // resolves it with the DECRYPTED key.
    expect(pub.defaultProviderId).toBe(pub.providers[0].id);
    const resolved = await store.resolveProvider(USER);
    expect(resolved?.providerType).toBe("openai");
    expect(resolved?.apiKey).toBe(OPENAI_KEY);
  });

  it("setDefault picks which provider run-resolution returns (default selection flows through)", async () => {
    const { getUserSettingsStore } = await import("@/server/store/user-settings");
    const store = await getUserSettingsStore();
    const a = await store.saveProvider(USER, { name: "A", providerType: "anthropic", apiKey: "sk-ant-aaaaaaaaaaaaaaaa" });
    const g = await store.saveProvider(USER, { name: "G", providerType: "gemini", apiKey: "gem-bbbbbbbbbbbbbbbb" });

    // The first save is default; resolution returns it.
    expect((await store.resolveProvider(USER))?.providerType).toBe("anthropic");

    // Switch the default → resolution now returns the gemini provider.
    await store.setDefault(USER, g.id);
    expect((await store.getPublic(USER)).defaultProviderId).toBe(g.id);
    const resolved = await store.resolveProvider(USER);
    expect(resolved?.providerType).toBe("gemini");
    expect(resolved?.apiKey).toBe("gem-bbbbbbbbbbbbbbbb");

    // Removing the default falls back to the remaining provider.
    await store.removeProvider(USER, g.id);
    expect((await store.getPublic(USER)).defaultProviderId).toBe(a.id);
  });

  it("supports an openai-compatible provider with a baseUrl (no anthropic key required)", async () => {
    const { getUserSettingsStore } = await import("@/server/store/user-settings");
    const store = await getUserSettingsStore();
    await store.saveProvider(USER, {
      name: "Local LM",
      providerType: "openai-compatible",
      baseUrl: "https://lm.example.com/v1",
      apiKey: "local-key-xxxxxxxx"
    });
    const resolved = await store.resolveProvider(USER);
    expect(resolved?.providerType).toBe("openai-compatible");
    expect(resolved?.baseUrl).toBe("https://lm.example.com/v1");
  });

  it("enforces the ALLOWED_PROVIDERS provider-lock on save (server-authoritative)", async () => {
    process.env.ALLOWED_PROVIDERS = "anthropic";
    const { getUserSettingsStore } = await import("@/server/store/user-settings");
    const store = await getUserSettingsStore();
    // anthropic is allowed.
    await expect(
      store.saveProvider(USER, { name: "A", providerType: "anthropic", apiKey: "sk-ant-aaaaaaaaaaaaaaaa" })
    ).resolves.toBeTruthy();
    // openai is NOT — rejected even though the UI would hide it.
    await expect(
      store.saveProvider(USER, { name: "O", providerType: "openai", apiKey: "sk-openai-xxxxxxxx" })
    ).rejects.toThrow(/not allowed/i);
  });
});
