/**
 * Automations client wrappers (lib/automations/client.ts) + provider presets
 * (lib/automations/presets.ts). The wrappers must hit the contract-fixed
 * routes with cookie credentials and unwrap/throw consistently; the presets
 * must substitute the real emit URL into their instructions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventSourceProviderSchema } from "@agentkitforge/contracts";
import {
  createEventSource,
  listTriggers,
  replayEvent,
  resumeTrigger,
  rotateEventSourceToken,
  testFireTrigger
} from "@/lib/automations/client";
import { buildEmitUrl, PROVIDER_PRESETS, TOKEN_PLACEHOLDER } from "@/lib/automations/presets";

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

describe("automations client", () => {
  it("listTriggers unwraps { triggers } from the contract route with cookies", async () => {
    const fn = mockFetch(200, { triggers: [{ id: "t1" }] });
    const triggers = await listTriggers();
    expect(triggers).toEqual([{ id: "t1" }]);
    expect(fn).toHaveBeenCalledWith("/api/auto/triggers", expect.objectContaining({ credentials: "include" }));
  });

  it("createEventSource POSTs the body (incl. write-only signingSecret) and returns the one-time token", async () => {
    const fn = mockFetch(200, { id: "src1", token: "one-time" });
    const res = await createEventSource({ name: "GitHub", kind: "provider", provider: "github", signingSecret: "shh" });
    expect(res.token).toBe("one-time");
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auto/event-sources");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "GitHub",
      kind: "provider",
      provider: "github",
      signingSecret: "shh"
    });
  });

  it("resumeTrigger PATCHes enabled:true (the contract-shaped circuit reset)", async () => {
    const fn = mockFetch(200, { id: "t1", enabled: true });
    await resumeTrigger("t1");
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auto/triggers/t1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
  });

  it("testFireTrigger sends the sampleEvent (or an empty body without one)", async () => {
    const fn = mockFetch(200, { fireLog: { id: "f1", outcome: "run_created" } });
    await testFireTrigger("t1", { hello: "world" });
    let [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ sampleEvent: { hello: "world" } });
    await testFireTrigger("t1");
    [, init] = fn.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("replayEvent POSTs { eventId } to the source-scoped contract route", async () => {
    const fn = mockFetch(200, { ok: true });
    await replayEvent("src1", "evt9");
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auto/event-sources/src1/replay");
    expect(JSON.parse(String(init.body))).toEqual({ eventId: "evt9" });
  });

  it("rotateEventSourceToken POSTs to the rotate-token subroute", async () => {
    const fn = mockFetch(200, { id: "src1", token: "fresh" });
    const res = await rotateEventSourceToken("src1");
    expect(res.token).toBe("fresh");
    expect((fn.mock.calls[0] as unknown as [string])[0]).toBe("/api/auto/event-sources/src1/rotate-token");
  });

  it("surfaces server error messages", async () => {
    mockFetch(403, { error: "nope" });
    await expect(listTriggers()).rejects.toThrow("nope");
    mockFetch(500, {});
    await expect(listTriggers()).rejects.toThrow("HTTP 500");
  });
});

describe("provider presets", () => {
  it("covers the 14 launch integrations with unique ids", () => {
    expect(PROVIDER_PRESETS).toHaveLength(14);
    expect(new Set(PROVIDER_PRESETS.map((p) => p.id)).size).toBe(14);
  });

  it("signature-verified presets carry a contract-valid provider", () => {
    const verified = PROVIDER_PRESETS.filter((p) => p.signatureVerified);
    expect(verified.map((p) => p.provider).sort()).toEqual(["github", "slack", "sns", "stripe"]);
    for (const p of verified) {
      expect(eventSourceProviderSchema.safeParse(p.provider).success).toBe(true);
    }
    // Non-verified integrations stay custom sources (no provider set).
    for (const p of PROVIDER_PRESETS.filter((p) => !p.signatureVerified)) {
      expect(p.provider).toBeUndefined();
    }
  });

  it("every preset substitutes the real emit URL into its instructions", () => {
    const url = buildEmitUrl("https://auto.example.com", "src1", "my-event", "tok123");
    for (const p of PROVIDER_PRESETS) {
      expect(p.instructions(url).join("\n")).toContain(url);
    }
  });

  it("buildEmitUrl builds the Seam-C path and encodes the token", () => {
    expect(buildEmitUrl("https://auto.example.com", "src 1", "deploy.done", "a+b/c")).toBe(
      "https://auto.example.com/api/hooks/auto/events/src%201/deploy.done?token=a%2Bb%2Fc"
    );
    // Token unknown after the one-time reveal → placeholder.
    expect(buildEmitUrl("https://x.test", "s", "e")).toContain(`?token=${TOKEN_PLACEHOLDER}`);
    // Blank event names fall back to a sane default.
    expect(buildEmitUrl("https://x.test", "s", "  ")).toContain("/events/s/my-event?");
  });
});
