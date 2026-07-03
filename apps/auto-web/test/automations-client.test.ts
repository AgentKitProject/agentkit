/**
 * Automations client wrappers (lib/automations/client.ts) + provider presets
 * (lib/automations/presets.ts). The wrappers must hit the contract-fixed
 * routes with cookie credentials and unwrap/throw consistently; the presets
 * must substitute the real emit URL into their instructions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventSourceProviderSchema } from "@agentkitforge/contracts";
import {
  createConnection,
  createEventSource,
  listConnections,
  listTriggers,
  replayEvent,
  resumeTrigger,
  rotateEventSourceToken,
  testFireTrigger,
  verifyConnection
} from "@/lib/automations/client";
import {
  buildEmitUrl,
  GENERIC_PRESETS,
  PROVIDER_PRESETS,
  TOKEN_PLACEHOLDER,
  VERIFIED_PRESETS
} from "@/lib/automations/presets";

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

  it("listConnections unwraps { connections } from the connections route with cookies", async () => {
    const fn = mockFetch(200, { connections: [{ id: "c1", type: "s3" }] });
    const conns = await listConnections();
    expect(conns).toEqual([{ id: "c1", type: "s3" }]);
    expect(fn).toHaveBeenCalledWith("/api/auto/connections", expect.objectContaining({ credentials: "include" }));
  });

  it("createConnection POSTs the connection body to the connections route", async () => {
    const fn = mockFetch(201, { id: "c1", type: "s3" });
    await createConnection({
      type: "s3",
      name: "Inbox",
      config: { bucket: "b", region: "us-east-1" },
      secret: '{"accessKeyId":"AKIA","secretAccessKey":"shh"}',
      ownerType: "user"
    });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auto/connections");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ type: "s3", name: "Inbox" });
  });

  it("verifyConnection POSTs to the verify subroute and returns the probe result", async () => {
    const fn = mockFetch(200, { id: "c1", type: "s3", status: "ok" });
    const res = await verifyConnection("c1");
    expect(res.status).toBe("ok");
    expect((fn.mock.calls[0] as unknown as [string])[0]).toBe("/api/auto/connections/c1/verify");
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

  it("categorizes into exactly 4 verified + 10 generic (Verified + one Generic group)", () => {
    // The verified group = the 4 signature-verified, first-party integrations.
    expect(VERIFIED_PRESETS.map((p) => p.id).sort()).toEqual(
      ["cloudwatch-sns", "github", "slack-workflow", "stripe"].sort()
    );
    expect(VERIFIED_PRESETS.every((p) => p.category === "verified" && p.signatureVerified)).toBe(true);
    // The generic group = the remaining 10, consolidated under one entry's
    // "using…" picker. Each is a plain token source (no provider, not verified).
    expect(GENERIC_PRESETS).toHaveLength(10);
    expect(GENERIC_PRESETS.every((p) => p.category === "generic" && !p.signatureVerified && !p.provider)).toBe(true);
    // The two groups together are the whole (unchanged) preset list.
    expect(VERIFIED_PRESETS.length + GENERIC_PRESETS.length).toBe(PROVIDER_PRESETS.length);
  });

  it("the Generic 'using…' pick swaps the copy-paste instructions (no capability lost)", () => {
    const url = buildEmitUrl("https://auto.example.com", "src1", "e", "tok");
    const zapier = GENERIC_PRESETS.find((p) => p.id === "zapier")!;
    const twilio = GENERIC_PRESETS.find((p) => p.id === "twilio-sms")!;
    expect(zapier.instructions(url).join("\n")).toContain("Zapier");
    expect(twilio.instructions(url).join("\n")).toContain("Twilio");
    // Different picks → different instruction bodies (the swap does something).
    expect(zapier.instructions(url)).not.toEqual(twilio.instructions(url));
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
