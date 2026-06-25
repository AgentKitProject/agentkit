// Verifies WebForgeClient.runAgentKitWithAi creates a gateway session, posts a
// turn, and parses the SSE stream into text deltas + usage + done — and that the
// low-level consumeSse parser handles chunk boundaries that split frames/JSON.
import { describe, expect, it, vi } from "vitest";
import { consumeSse, HttpError, WebForgeClient, type GatewayStreamEvent } from "@/forge-client/web-client";

/** Builds a Response whose body streams `chunks` (already-encoded strings). */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    }
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

function frame(event: GatewayStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

describe("consumeSse", () => {
  it("parses well-formed frames", async () => {
    const res = sseResponse([
      frame({ type: "text", delta: "Hello" }),
      frame({ type: "text", delta: " world" }),
      frame({ type: "usage", input: 12, output: 3, cached: 0 }),
      frame({ type: "done", stopReason: "end_turn" })
    ]);
    const events: GatewayStreamEvent[] = [];
    await consumeSse(res, (e) => events.push(e));
    expect(events).toEqual([
      { type: "text", delta: "Hello" },
      { type: "text", delta: " world" },
      { type: "usage", input: 12, output: 3, cached: 0 },
      { type: "done", stopReason: "end_turn" }
    ]);
  });

  it("reassembles frames split across read boundaries", async () => {
    // Split a single frame's JSON in the middle and the frame separator too.
    const full = frame({ type: "text", delta: "streamed" }) + frame({ type: "done", stopReason: "end_turn" });
    const mid = Math.floor(full.length / 2);
    const res = sseResponse([full.slice(0, mid), full.slice(mid)]);
    const events: GatewayStreamEvent[] = [];
    await consumeSse(res, (e) => events.push(e));
    expect(events).toEqual([
      { type: "text", delta: "streamed" },
      { type: "done", stopReason: "end_turn" }
    ]);
  });

  it("ignores malformed and non-data frames", async () => {
    const res = sseResponse([": keep-alive comment\n\n", "data: {not json}\n\n", frame({ type: "text", delta: "ok" })]);
    const events: GatewayStreamEvent[] = [];
    await consumeSse(res, (e) => events.push(e));
    expect(events).toEqual([{ type: "text", delta: "ok" }]);
  });
});

describe("WebForgeClient.runAgentKitWithAi", () => {
  it("creates a session, posts a turn, and accumulates streamed text + usage", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/gateway/sessions")) {
        return new Response(JSON.stringify({ sessionId: "sess_1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      // /turn → SSE stream.
      return sseResponse([
        frame({ type: "text", delta: "Hi" }),
        frame({ type: "text", delta: " there" }),
        frame({ type: "usage", input: 5, output: 2, cached: 0 }),
        frame({ type: "done", stopReason: "end_turn" })
      ]);
    });
    const client = new WebForgeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const tokens: string[] = [];
    const result = (await client.runAgentKitWithAi({
      kitId: "my-kit",
      prompt: "hello",
      model: "claude-sonnet-4-6",
      onToken: (d: string) => tokens.push(d)
    })) as { sessionId: string; text: string; stopReason: string; usage?: { input: number } };

    expect(result.text).toBe("Hi there");
    expect(result.sessionId).toBe("sess_1");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage?.input).toBe(5);
    expect(tokens).toEqual(["Hi", " there"]);

    // Session create body carries kitId + managed billing + model.
    const create = calls.find((c) => c.url.endsWith("/api/gateway/sessions"))!;
    expect(JSON.parse(String(create.init?.body))).toMatchObject({ kitId: "my-kit", billing: "managed", model: "claude-sonnet-4-6" });
    // Turn posts to the session id with the user input.
    const turn = calls.find((c) => c.url.includes("/turn"))!;
    expect(turn.url).toBe("/api/gateway/sessions/sess_1/turn");
    expect(JSON.parse(String(turn.init?.body))).toMatchObject({ userInput: "hello", model: "claude-sonnet-4-6" });
  });

  it("reuses an existing sessionId instead of creating a new session", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return sseResponse([frame({ type: "text", delta: "again" }), frame({ type: "done", stopReason: "end_turn" })]);
    });
    const client = new WebForgeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = (await client.runAgentKitWithAi({ kitId: "k", prompt: "p", sessionId: "sess_existing" })) as {
      sessionId: string;
      text: string;
    };
    expect(result.sessionId).toBe("sess_existing");
    expect(result.text).toBe("again");
    expect(calls.some((u) => u.endsWith("/api/gateway/sessions"))).toBe(false);
    expect(calls).toContain("/api/gateway/sessions/sess_existing/turn");
  });

  it("surfaces a 402 insufficient-credits turn as an HttpError with the credit body", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/gateway/sessions")) {
        return new Response(JSON.stringify({ sessionId: "sess_x" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(
        JSON.stringify({ error: "insufficient_credits", message: "Out of credits.", requiredCents: 50, availableCents: 0 }),
        { status: 402, headers: { "content-type": "application/json" } }
      );
    });
    const client = new WebForgeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.runAgentKitWithAi({ kitId: "k", prompt: "p" })).rejects.toMatchObject({
      status: 402
    });
    // The error carries the machine-readable body for the top-up affordance.
    try {
      await client.runAgentKitWithAi({ kitId: "k", prompt: "p" });
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).body).toMatchObject({ requiredCents: 50 });
    }
  });

  it("ends a session via DELETE", async () => {
    const calls: { url: string; method?: string }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(null, { status: 204 });
    });
    const client = new WebForgeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.endAgentKitSession("sess_1");
    expect(calls[0]).toEqual({ url: "/api/gateway/sessions/sess_1", method: "DELETE" });
  });
});
