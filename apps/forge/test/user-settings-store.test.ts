import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UserSettingsStore } from "@/server/store/user-settings";

let dataDir: string;
const USER = "user_settings_test";

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "akf-settings-test-"));
  process.env.AGENTKITFORGE_WEB_DATA_DIR = dataDir;
  // Enable at-rest encryption for the encryption assertions.
  process.env.AGENTKITFORGE_WEB_SECRET = crypto.randomBytes(32).toString("hex");
});

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  delete process.env.AGENTKITFORGE_WEB_SECRET;
});

describe("UserSettingsStore", () => {
  it("saves a provider, strips secrets on the public view, and resolves the decrypted key", async () => {
    const store = new UserSettingsStore();
    const pub = await store.saveProvider(USER, {
      name: "My OpenAI",
      providerType: "openai",
      apiKey: "sk-secret-123",
      defaultModel: "gpt-4o"
    });
    expect(pub.hasApiKey).toBe(true);
    // Public view never exposes the key.
    expect((pub as Record<string, unknown>).apiKey).toBeUndefined();

    const publicView = await store.getPublic(USER);
    expect(publicView.providers).toHaveLength(1);
    expect(publicView.defaultProviderId).toBe(pub.id); // first provider becomes default
    expect(publicView.providers[0].hasApiKey).toBe(true);

    // resolveProvider returns the DECRYPTED key for server-side AI calls.
    const resolved = await store.resolveProvider(USER);
    expect(resolved?.apiKey).toBe("sk-secret-123");
  });

  it("persists the key ENCRYPTED at rest (not plaintext on disk)", async () => {
    const raw = await fs.readFile(path.join(dataDir, "users", USER, "settings.json"), "utf8");
    expect(raw).not.toContain("sk-secret-123");
    expect(raw).toContain("enc:v1:");
  });

  it("keeps the existing key when an update omits apiKey", async () => {
    const store = new UserSettingsStore();
    const [existing] = (await store.getPublic(USER)).providers;
    await store.saveProvider(USER, {
      id: existing.id,
      name: "Renamed",
      providerType: "openai"
    });
    const resolved = await store.resolveProvider(USER, existing.id);
    expect(resolved?.name).toBe("Renamed");
    expect(resolved?.apiKey).toBe("sk-secret-123");
  });

  it("sets default and removes providers, reassigning the default", async () => {
    const store = new UserSettingsStore();
    const second = await store.saveProvider(USER, { name: "Anthropic", providerType: "anthropic", apiKey: "ak-2" });
    await store.setDefault(USER, second.id);
    expect((await store.getPublic(USER)).defaultProviderId).toBe(second.id);

    await store.removeProvider(USER, second.id);
    const after = await store.getPublic(USER);
    expect(after.providers.some((p) => p.id === second.id)).toBe(false);
    expect(after.defaultProviderId).toBe(after.providers[0]?.id);
  });
});
