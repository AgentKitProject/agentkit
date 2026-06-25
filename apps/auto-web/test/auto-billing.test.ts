// Phase 2 — billing resolution honors the BYO key + inference-mode preference
// (server/core/auto.ts resolveAutoBilling).
//
// Test-mode only: a local KitStore-backed kit (never protected → no Market /
// network), the disk UserSettingsStore over a temp dir, a mocked provider key
// (no real Anthropic call). Covers:
//   - configured BYO key + "auto"/"byo" preference → inferenceMode "byo" with a
//     byoChatProvider (the user's key path; ledger untouched);
//   - "managed" preference → inferenceMode "managed" even with a key on file
//     (no byoChatProvider — the platform credit path);
//   - a per-run override beats the account preference both ways.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// auto.ts pulls in modules that transitively import AuthKit; stub it so the
// module graph LOADS in the bare vitest env (we never exercise its network path).
vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: vi.fn(),
  getSignInUrl: vi.fn(),
  handleAuth: vi.fn(),
  saveSession: vi.fn(),
  authkitMiddleware: vi.fn(() => vi.fn())
}));

const ORIGINAL_ENV = { ...process.env };
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "auto-billing-test-"));
  process.env.KITSTORE_BACKEND = "local";
  process.env.AGENTKITFORGE_WEB_DATA_DIR = dataDir;
  process.env.AGENTKITFORGE_WEB_SECRET = "b".repeat(64);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

const USER = "user-1";
const KEY = "sk-ant-api03-BILLINGTESTKEY1234567890";
// A local kit is never protected, so billing never touches Market.
const LOCAL_KIT = { source: "local" as const, localKitId: "kit-abc" };

describe("resolveAutoBilling — BYO vs managed", () => {
  it("BYO key + automatic preference → mode byo with a byoChatProvider", async () => {
    const { setByoKey } = await import("@/server/core/auto-byo");
    await setByoKey(USER, { apiKey: KEY });

    const { resolveAutoBilling } = await import("@/server/core/auto");
    const billing = await resolveAutoBilling({
      userId: USER,
      kitRef: LOCAL_KIT,
      isCloudRun: false,
      kitContext: {}
    });
    expect(billing.inferenceMode).toBe("byo");
    expect(billing.byoChatProvider).toBeDefined();
  });

  it('"managed" preference forces managed even with a key on file', async () => {
    const { setByoKey } = await import("@/server/core/auto-byo");
    await setByoKey(USER, { apiKey: KEY, inferenceMode: "managed" });

    const { resolveAutoBilling } = await import("@/server/core/auto");
    const billing = await resolveAutoBilling({
      userId: USER,
      kitRef: LOCAL_KIT,
      isCloudRun: false,
      kitContext: {}
    });
    expect(billing.inferenceMode).toBe("managed");
    expect(billing.byoChatProvider).toBeUndefined();
  });

  it("a per-run override beats the account preference (managed→byo and byo→managed)", async () => {
    const { setByoKey } = await import("@/server/core/auto-byo");
    await setByoKey(USER, { apiKey: KEY, inferenceMode: "managed" });

    const { resolveAutoBilling } = await import("@/server/core/auto");

    const forcedByo = await resolveAutoBilling({
      userId: USER,
      kitRef: LOCAL_KIT,
      isCloudRun: false,
      kitContext: {},
      inferenceModeOverride: "byo"
    });
    expect(forcedByo.inferenceMode).toBe("byo");
    expect(forcedByo.byoChatProvider).toBeDefined();

    const forcedManaged = await resolveAutoBilling({
      userId: USER,
      kitRef: LOCAL_KIT,
      isCloudRun: false,
      kitContext: {},
      inferenceModeOverride: "managed"
    });
    expect(forcedManaged.inferenceMode).toBe("managed");
    expect(forcedManaged.byoChatProvider).toBeUndefined();
  });

  it("no key → managed (no byoChatProvider), in the hosted default", async () => {
    const { resolveAutoBilling } = await import("@/server/core/auto");
    const billing = await resolveAutoBilling({
      userId: "user-without-key",
      kitRef: LOCAL_KIT,
      isCloudRun: false,
      kitContext: {}
    });
    expect(billing.inferenceMode).toBe("managed");
    expect(billing.byoChatProvider).toBeUndefined();
  });
});
