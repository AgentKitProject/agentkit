/**
 * Tool-loop state machine tests for runStreamingTurn / resumeWithToolResults.
 *
 * Uses a SCRIPTED streaming ChatProvider (text → tool_use → pause → tool-result
 * → continue → done) over the in-memory ledger + session store fakes.
 *
 * Verifies:
 *   - only allowed StreamEvents cross the boundary (no system prompt ever)
 *   - the turn PAUSES on tool_use (status awaiting_tool_results, pending tools)
 *   - resume continues under the SAME hold and settles with SUMMED usage
 *   - insufficient credits rejects BEFORE any provider call
 *   - a provider error releases the hold (buyer not charged)
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { ChatProvider, StreamEvent } from "../src/core/ports.js";
import type {
  ChatRequest,
  ChatResponse,
  GatewaySession,
  TokenUsage,
} from "../src/core/types.js";
import {
  runStreamingTurn,
  resumeWithToolResults,
  InvalidTurnStateError,
  type StreamingTurnDeps,
} from "../src/core/services/streaming-turn.js";
import { InsufficientCreditsError } from "../src/core/services/managed-turn.js";
import { computeDebitCents } from "../src/core/pricing.js";
import { DEFAULT_MARKUP_BPS } from "../src/core/config.js";
import { InMemoryLedger, InMemorySessionStore } from "./fakes.js";

const MODEL = "claude-sonnet-4-5";
const NOW = "2026-06-17T12:00:00Z";
const SECRET_PROMPT = "SECRET KIT INSTRUCTIONS — never leaves the server";

function usage(input: number, output: number): TokenUsage {
  return { inputTokens: input, outputTokens: output, cachedReadTokens: 0, cachedWriteTokens: 0 };
}

/**
 * A scripted streaming provider. Each call shifts the next scripted response,
 * synthesises StreamEvents from it (so we can assert the boundary), and returns
 * the full ChatResponse. Records every system prompt it was asked to send.
 */
function scriptedProvider(script: ChatResponse[]): {
  provider: ChatProvider;
  systemPromptsSeen: string[];
  calls: number;
} {
  const systemPromptsSeen: string[] = [];
  let i = 0;
  const provider: ChatProvider = {
    providerType: "anthropic",
    sendMessage: async () => {
      throw new Error("not used in streaming test");
    },
    streamMessage: async (request: ChatRequest, onEvent: (e: StreamEvent) => void) => {
      systemPromptsSeen.push(request.system);
      const resp = script[i++];
      if (!resp) throw new Error("script exhausted");
      for (const block of resp.content) {
        if (block.type === "text") {
          onEvent({ type: "text", delta: block.text });
        } else if (block.type === "tool_use") {
          onEvent({ type: "tool_use", toolUseId: block.id, name: block.name, inputPartial: "{}" });
          onEvent({ type: "tool_use", toolUseId: block.id, name: block.name, inputComplete: block.input });
        }
      }
      onEvent({ type: "usage", input: resp.usage.inputTokens, output: resp.usage.outputTokens, cached: 0 });
      onEvent({ type: "done", stopReason: resp.stopReason });
      return resp;
    },
  };
  return { provider, systemPromptsSeen, calls: i };
}

function makeDeps(
  provider: ChatProvider,
  ledger: InMemoryLedger,
  sessions: InMemorySessionStore,
  overrides: Partial<StreamingTurnDeps> = {},
): StreamingTurnDeps {
  return {
    chatProvider: provider,
    ledger,
    sessions,
    resolveSystemPrompt: async () => SECRET_PROMPT,
    resolveTools: async () => [
      { name: "read_file", description: "read", inputSchema: { type: "object" } },
    ],
    now: () => NOW,
    model: MODEL,
    maxTokens: 1024,
    ...overrides,
  };
}

async function seedSession(
  sessions: InMemorySessionStore,
  billingMode: "managed" | "byo" = "managed",
): Promise<GatewaySession> {
  return sessions.createSession({
    userId: "user-1",
    kitId: "kit-1",
    kitSlug: "kit-1",
    systemPromptRef: "ref-1",
    billingMode,
    byoProviderConfig: null,
    createdAt: NOW,
    // Far-future TTL so the fake's lazy-expiry check (vs real Date.now()) passes.
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
}

describe("runStreamingTurn / resumeWithToolResults — tool loop", () => {
  let ledger: InMemoryLedger;
  let sessions: InMemorySessionStore;

  beforeEach(() => {
    ledger = new InMemoryLedger();
    sessions = new InMemorySessionStore();
  });

  it("text→tool_use pauses; resume→done settles ONE hold with SUMMED usage; system prompt never emitted", async () => {
    await ledger.topup("user-1", 100000, NOW);
    const session = await seedSession(sessions);

    const round1Usage = usage(1000, 200);
    const round2Usage = usage(1500, 300);
    const { provider, systemPromptsSeen } = scriptedProvider([
      // Round 1: a bit of text + a tool_use → pause.
      {
        content: [
          { type: "text", text: "Reading the file." },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "/a.txt" } },
        ],
        stopReason: "tool_use",
        usage: round1Usage,
      },
      // Round 2 (after tool result): final answer → natural stop.
      {
        content: [{ type: "text", text: "Done — the file says hi." }],
        stopReason: "end_turn",
        usage: round2Usage,
      },
    ]);
    const deps = makeDeps(provider, ledger, sessions);

    // --- Turn 1: run → pause ---
    const events1: StreamEvent[] = [];
    const r1 = await runStreamingTurn(deps, session.sessionId, { userInput: "read /a.txt" }, (e) =>
      events1.push(e),
    );

    expect(r1.status).toBe("awaiting_tool_results");
    expect(r1.stopReason).toBe("tool_use");
    expect(r1.pendingToolUse).toEqual([
      { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "/a.txt" } },
    ]);
    expect(r1.debitedCents).toBe(0); // not settled yet

    // Only allowed event types crossed the boundary.
    const allowed = new Set(["text", "tool_use", "usage", "done", "error"]);
    expect(events1.every((e) => allowed.has(e.type))).toBe(true);
    // The secret prompt was NEVER emitted in any event payload.
    const serialized1 = JSON.stringify(events1);
    expect(serialized1).not.toContain("SECRET KIT INSTRUCTIONS");
    // But the provider DID receive it server-side.
    expect(systemPromptsSeen[0]).toBe(SECRET_PROMPT);

    // Session is paused with one open hold; held balance reserved, nothing debited.
    const paused = await sessions.getSession(session.sessionId);
    expect(paused?.turnState?.status).toBe("awaiting_tool_results");
    expect(paused?.turnState?.holdId).toBeTruthy();
    const holdId = paused!.turnState!.holdId!;
    expect((await ledger.getHold(holdId))?.status).toBe("open");
    const acctPaused = await ledger.getAccount("user-1");
    expect(acctPaused?.heldBalanceCents).toBeGreaterThan(0);
    expect(ledger.txns.some((t) => t.type === "debit")).toBe(false);

    // --- Turn 1 continued: resume with the tool result → done + settle ---
    const events2: StreamEvent[] = [];
    const r2 = await resumeWithToolResults(
      deps,
      session.sessionId,
      [{ toolUseId: "toolu_1", result: "file contents: hi" }],
      (e) => events2.push(e),
    );

    expect(r2.status).toBe("completed");
    expect(r2.stopReason).toBe("end_turn");

    // Usage summed across BOTH round-trips, settled against the SAME hold.
    const summed = usage(1000 + 1500, 200 + 300);
    const expectedDebit = computeDebitCents(summed, MODEL, DEFAULT_MARKUP_BPS);
    expect(r2.usage).toEqual(summed);
    expect(r2.debitedCents).toBe(expectedDebit);

    // The single hold was settled (not a second hold).
    expect((await ledger.getHold(holdId))?.status).toBe("settled");
    const openHolds = [...ledger.holds.values()].filter((h) => h.status === "open");
    expect(openHolds.length).toBe(0);
    const acctDone = await ledger.getAccount("user-1");
    expect(acctDone?.heldBalanceCents).toBe(0);
    expect(acctDone?.availableBalanceCents).toBe(100000 - expectedDebit);
    expect(r2.balanceCents).toBe(100000 - expectedDebit);

    // Exactly one debit transaction for the whole turn.
    const debits = ledger.txns.filter((t) => t.type === "debit");
    expect(debits.length).toBe(1);
    expect(debits[0]!.amountCents).toBe(expectedDebit);

    // Session turn state reset to idle; history has user + assistant + tool_result + assistant.
    const finalSession = await sessions.getSession(session.sessionId);
    expect(finalSession?.turnState?.status).toBe("idle");
    expect(finalSession?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    // Resume stream also never leaked the secret prompt.
    expect(JSON.stringify(events2)).not.toContain("SECRET KIT INSTRUCTIONS");
  });

  it("insufficient credits: rejects BEFORE any provider call", async () => {
    await ledger.topup("user-1", 1, NOW); // 1¢ — far below any hold
    const session = await seedSession(sessions);

    let streamCalled = false;
    const { provider } = scriptedProvider([
      { content: [{ type: "text", text: "x" }], stopReason: "end_turn", usage: usage(10, 10) },
    ]);
    const wrapped: ChatProvider = {
      ...provider,
      streamMessage: async (...args) => {
        streamCalled = true;
        return provider.streamMessage(...args);
      },
    };
    const deps = makeDeps(wrapped, ledger, sessions);

    await expect(
      runStreamingTurn(deps, session.sessionId, { userInput: "hi" }, () => {}),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(streamCalled).toBe(false);
    const acct = await ledger.getAccount("user-1");
    expect(acct?.availableBalanceCents).toBe(1);
    expect(acct?.heldBalanceCents).toBe(0);
  });

  it("provider error: releases the hold (buyer not charged) and rethrows", async () => {
    await ledger.topup("user-1", 100000, NOW);
    const session = await seedSession(sessions);

    const boom = new Error("provider 500");
    const provider: ChatProvider = {
      providerType: "anthropic",
      sendMessage: async () => {
        throw boom;
      },
      streamMessage: async (_req, onEvent) => {
        onEvent({ type: "error", message: "provider 500" });
        throw boom;
      },
    };
    const deps = makeDeps(provider, ledger, sessions);

    await expect(
      runStreamingTurn(deps, session.sessionId, { userInput: "hi" }, () => {}),
    ).rejects.toBe(boom);

    // Full balance restored, nothing held, nothing debited.
    const acct = await ledger.getAccount("user-1");
    expect(acct?.availableBalanceCents).toBe(100000);
    expect(acct?.heldBalanceCents).toBe(0);
    expect(ledger.txns.some((t) => t.type === "debit")).toBe(false);
    expect(ledger.txns.some((t) => t.type === "hold")).toBe(true);
    expect(ledger.txns.some((t) => t.type === "hold_release")).toBe(true);

    // Turn reset to idle so the session can start fresh.
    const s = await sessions.getSession(session.sessionId);
    expect(s?.turnState?.status ?? "idle").toBe("idle");
  });

  it("BYO mode: no hold, no settle, but the loop still runs to completion", async () => {
    const session = await seedSession(sessions, "byo");
    const { provider } = scriptedProvider([
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: usage(100, 50) },
    ]);
    const deps = makeDeps(provider, ledger, sessions);

    const r = await runStreamingTurn(deps, session.sessionId, { userInput: "hi" }, () => {});

    expect(r.status).toBe("completed");
    expect(r.debitedCents).toBe(0);
    expect(r.balanceCents).toBeUndefined();
    expect(ledger.txns.length).toBe(0); // ledger never touched
  });

  it("resume without a paused turn throws InvalidTurnStateError", async () => {
    const session = await seedSession(sessions, "byo");
    const { provider } = scriptedProvider([]);
    const deps = makeDeps(provider, ledger, sessions);

    await expect(
      resumeWithToolResults(deps, session.sessionId, [{ toolUseId: "x", result: "y" }], () => {}),
    ).rejects.toBeInstanceOf(InvalidTurnStateError);
  });
});
