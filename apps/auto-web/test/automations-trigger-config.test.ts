/**
 * Pure builders for the three additional wizard trigger kinds
 * (lib/automations/trigger-config.ts): RSS, kit-chaining (run_completed), and
 * inbound email (email_in). Each builder must produce a config that — wrapped in
 * the wizard's base fields — passes the contracts discriminated
 * createTriggerRequestSchema, and the wizard must NEVER send server-owned
 * email_in fields (address/addressSlug). Also covers the email_in feature-detect
 * client wrapper (hosted-only availability) + the minted-address display path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTriggerRequestSchema,
  emailInTriggerConfigSchema,
  rssTriggerConfigSchema,
  runCompletedTriggerConfigSchema,
  type RunTerminalStatus
} from "@agentkitforge/contracts";
import {
  buildEmailInConfig,
  buildRssConfig,
  buildRunCompletedConfig,
  isValidFeedUrl,
  looksLikeEmail,
  parseAllowlistInput,
  RUN_TERMINAL_STATUSES
} from "@/lib/automations/trigger-config";
import { buildTriggerMapping } from "@/lib/automations/watch-connect";
import { createTrigger, emailInAvailability } from "@/lib/automations/client";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The wizard's base fields shared by every create request (kit + approval +
 *  mapping), for wrapping a built config into a full contract check. */
const BASE = {
  name: "Test automation",
  kitRef: { source: "local" as const, localKitId: "kit1" },
  approvalId: "appr1",
  mapping: buildTriggerMapping("Summarize {{title}}", true),
  enabled: true
};

// ---------------------------------------------------------------------------
// RSS
// ---------------------------------------------------------------------------

describe("RSS trigger config", () => {
  it("builds a contract-valid rss config (feed trimmed, interval defaulted)", () => {
    const cfg = buildRssConfig({ feedUrl: "  https://example.com/feed.xml  ", intervalMinutes: 15 });
    expect(rssTriggerConfigSchema.safeParse(cfg).success).toBe(true);
    expect(cfg).toEqual({ feedUrl: "https://example.com/feed.xml", intervalMinutes: 15 });
  });

  it("clamps the interval to the contract 5–1440 window", () => {
    expect(buildRssConfig({ feedUrl: "https://x.test/f", intervalMinutes: 0 }).intervalMinutes).toBe(15);
    expect(buildRssConfig({ feedUrl: "https://x.test/f", intervalMinutes: 2 }).intervalMinutes).toBe(5);
    expect(buildRssConfig({ feedUrl: "https://x.test/f", intervalMinutes: 99999 }).intervalMinutes).toBe(1440);
  });

  it("validates feed URLs (https only, well-formed)", () => {
    expect(isValidFeedUrl("https://example.com/feed.xml")).toBe(true);
    expect(isValidFeedUrl("  https://example.com/feed  ")).toBe(true);
    expect(isValidFeedUrl("http://example.com/feed")).toBe(false); // not https
    expect(isValidFeedUrl("example.com/feed")).toBe(false);
    expect(isValidFeedUrl("https://")).toBe(false);
    expect(isValidFeedUrl("")).toBe(false);
  });

  it("a full rss create request passes the create-trigger contract", () => {
    const req = { ...BASE, type: "rss" as const, config: buildRssConfig({ feedUrl: "https://x.test/feed", intervalMinutes: 30 }) };
    expect(createTriggerRequestSchema.safeParse(req).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Kit chaining (run_completed)
// ---------------------------------------------------------------------------

describe("run_completed (kit chaining) trigger config", () => {
  it("defaults to succeeded when the built statuses match the contract default", () => {
    const cfg = buildRunCompletedConfig({ kitRef: null, statuses: ["succeeded"] });
    expect(runCompletedTriggerConfigSchema.safeParse(cfg).success).toBe(true);
    expect(cfg.statuses).toEqual(["succeeded"]);
    // "any kit" → kitRef omitted; no source restriction → sourceTriggerId omitted.
    expect("kitRef" in cfg).toBe(false);
    expect("sourceTriggerId" in cfg).toBe(false);
  });

  it("falls back to [succeeded] when no statuses are selected", () => {
    expect(buildRunCompletedConfig({ kitRef: null, statuses: [] }).statuses).toEqual(["succeeded"]);
  });

  it("normalizes selected-status order and de-dupes, keeping only valid ones", () => {
    const messy = ["failed", "succeeded", "failed"] as RunTerminalStatus[];
    const cfg = buildRunCompletedConfig({ kitRef: null, statuses: messy });
    // Canonical order from RUN_TERMINAL_STATUSES (succeeded before failed), de-duped.
    expect(cfg.statuses).toEqual(["succeeded", "failed"]);
    expect(runCompletedTriggerConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it("carries a specific kit when chosen (kitRef present)", () => {
    const kitRef = { source: "market" as const, marketKitId: "m1", slug: "cool-kit" };
    const cfg = buildRunCompletedConfig({ kitRef, statuses: ["succeeded", "budget_exceeded"] });
    expect(cfg.kitRef).toEqual(kitRef);
    expect(runCompletedTriggerConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it("carries the optional sourceTriggerId only when set (trimmed)", () => {
    expect("sourceTriggerId" in buildRunCompletedConfig({ kitRef: null, statuses: ["succeeded"], sourceTriggerId: "  " })).toBe(false);
    const cfg = buildRunCompletedConfig({ kitRef: null, statuses: ["succeeded"], sourceTriggerId: " trig-9 " });
    expect(cfg.sourceTriggerId).toBe("trig-9");
  });

  it("RUN_TERMINAL_STATUSES exactly covers the contract's terminal statuses", () => {
    const built = RUN_TERMINAL_STATUSES.map((s) => s.status).sort();
    expect(built).toEqual(["budget_exceeded", "canceled", "failed", "succeeded"]);
    for (const s of RUN_TERMINAL_STATUSES) {
      expect(runCompletedTriggerConfigSchema.safeParse({ statuses: [s.status] }).success).toBe(true);
    }
  });

  it("a full run_completed create request passes the create-trigger contract (any kit + specific)", () => {
    const anyKit = { ...BASE, type: "run_completed" as const, config: buildRunCompletedConfig({ kitRef: null, statuses: ["succeeded", "failed"] }) };
    expect(createTriggerRequestSchema.safeParse(anyKit).success).toBe(true);
    const specific = {
      ...BASE,
      type: "run_completed" as const,
      config: buildRunCompletedConfig({
        kitRef: { source: "local", localKitId: "kit1" },
        statuses: ["succeeded"],
        sourceTriggerId: "trig-1"
      })
    };
    expect(createTriggerRequestSchema.safeParse(specific).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Email-in
// ---------------------------------------------------------------------------

describe("email_in trigger config", () => {
  it("builds a contract-valid config carrying ONLY allowedFrom (no server-owned fields)", () => {
    const cfg = buildEmailInConfig({ allowedFrom: ["a@example.com"] });
    expect(emailInTriggerConfigSchema.safeParse(cfg).success).toBe(true);
    expect(cfg).toEqual({ allowedFrom: ["a@example.com"] });
    // The wizard NEVER sends the server-minted address/addressSlug.
    expect("address" in cfg).toBe(false);
    expect("addressSlug" in cfg).toBe(false);
    // connectionId (self-host IMAP) is out of scope — never sent.
    expect("connectionId" in cfg).toBe(false);
  });

  it("empty allowlist is valid (contract default [] = only the owner)", () => {
    const cfg = buildEmailInConfig({ allowedFrom: [] });
    expect(cfg).toEqual({ allowedFrom: [] });
    expect(emailInTriggerConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it("lowercases, trims, de-dupes, and caps the allowlist at 20", () => {
    const cfg = buildEmailInConfig({ allowedFrom: [" A@Example.com ", "a@example.com", "b@example.com"] });
    expect(cfg.allowedFrom).toEqual(["a@example.com", "b@example.com"]);

    const twentyFive = Array.from({ length: 25 }, (_, i) => `u${i}@example.com`);
    const capped = buildEmailInConfig({ allowedFrom: twentyFive });
    expect(capped.allowedFrom).toHaveLength(20);
    expect(emailInTriggerConfigSchema.safeParse(capped).success).toBe(true);
  });

  it("parseAllowlistInput splits on commas/whitespace; looksLikeEmail gates the add button", () => {
    expect(parseAllowlistInput(" a@x.com, b@x.com\n c@x.com ")).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    expect(parseAllowlistInput("   ")).toEqual([]);
    expect(looksLikeEmail("a@example.com")).toBe(true);
    expect(looksLikeEmail("not-an-email")).toBe(false);
    expect(looksLikeEmail("a@b")).toBe(false);
  });

  it("a full email_in create request passes the create-trigger contract", () => {
    const req = { ...BASE, type: "email_in" as const, config: buildEmailInConfig({ allowedFrom: ["ops@example.com"] }) };
    expect(createTriggerRequestSchema.safeParse(req).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Feature detection + minted-address display (client seam)
// ---------------------------------------------------------------------------

describe("email_in feature detection (hosted-only)", () => {
  it("emailInAvailability returns true only when the instance reports available", async () => {
    mockFetch(200, { available: true });
    expect(await emailInAvailability()).toBe(true);
    mockFetch(200, { available: false });
    expect(await emailInAvailability()).toBe(false);
    // Fields other than a literal true never count as available (fail closed).
    mockFetch(200, {});
    expect(await emailInAvailability()).toBe(false);
  });

  it("hits the availability route with cookie credentials", async () => {
    const fn = mockFetch(200, { available: true });
    await emailInAvailability();
    expect(fn).toHaveBeenCalledWith(
      "/api/auto/email-in/availability",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("the create response surfaces the server-minted address for display", async () => {
    // The wizard reads created.config.address (the `<slug>@<domain>` minted
    // server-side) to show + copy after a successful email_in create.
    const fn = mockFetch(201, {
      id: "t-email",
      type: "email_in",
      config: { address: "kit-abc123@auto.example.com", addressSlug: "kit-abc123", allowedFrom: [] }
    });
    const req = { ...BASE, type: "email_in" as const, config: buildEmailInConfig({ allowedFrom: [] }) };
    const created = await createTrigger(req);
    expect(created.type).toBe("email_in");
    expect(created.type === "email_in" ? created.config.address : null).toBe("kit-abc123@auto.example.com");
    const [url] = fn.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/auto/triggers");
  });
});
