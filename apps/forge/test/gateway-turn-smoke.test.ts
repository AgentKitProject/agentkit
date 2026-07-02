/**
 * Gateway turn smoke-test — Phase 2b integration check.
 *
 * Exercises the ENTIRE run/chat path end-to-end WITHOUT auth or a live model
 * call: in-memory SessionStore, in-memory CreditLedgerRepository, a mock
 * ChatProvider that emits a couple text deltas + usage + done, and a stub
 * resolveSystemPrompt returning a fixed secret string.
 *
 * Assertions:
 *   (a) routeGatewayRequest and runStreamingTurn resolve to real functions at
 *       import time — this is the direct test of the ESM/CJS tree-shaking concern
 *       flagged in Phase 2b.
 *   (b) Text deltas are emitted to the SSE emitter.
 *   (c) A done event arrives.
 *   (d) The system prompt SECRET is NEVER emitted to the client event stream
 *       (Tier-3 invariant).
 *   (e) The ledger records exactly ONE debit transaction and the balance drops by
 *       exactly computeDebitCents(mockUsage, model, DEFAULT_MARKUP_BPS).
 *   (f) Insufficient-balance ($0 seed) rejects pre-call with InsufficientCreditsError
 *       and the mock ChatProvider's streamMessage is never invoked.
 */
import { describe, expect, it, vi } from "vitest";
import {
  routeGatewayRequest,
  runStreamingTurn,
  computeDebitCents,
  DEFAULT_MARKUP_BPS,
  InsufficientCreditsError,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type CreditAccount,
  type CreditHold,
  type CreditLedgerRepository,
  type CreditTransaction,
  type GatewaySession,
  type RecordTransactionInput,
  type SessionStore,
  type StreamEvent,
  type TokenUsage,
} from "@agentkitforge/gateway-core";

// ---------------------------------------------------------------------------
// (a) Runtime-import assertion — this runs at module-evaluation time
// ---------------------------------------------------------------------------

// These must be functions, not undefined, regardless of tree-shaking or CJS/ESM
// interop issues.  The test file itself imports them; if they were undefined the
// assertions below would fail even before any it() body runs.
if (typeof routeGatewayRequest !== "function") {
  throw new Error(
    `FATAL: routeGatewayRequest is ${typeof routeGatewayRequest} at runtime — ` +
      "ESM/CJS tree-shaking or export wiring is broken."
  );
}
if (typeof runStreamingTurn !== "function") {
  throw new Error(
    `FATAL: runStreamingTurn is ${typeof runStreamingTurn} at runtime — ` +
      "ESM/CJS tree-shaking or export wiring is broken."
  );
}

// ---------------------------------------------------------------------------
// Constants used across tests
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-4-6";
const SYSTEM_SECRET = "SECRET_KIT_INSTRUCTIONS_DO_NOT_LEAK";
const SEED_BALANCE_CENTS = 500; // $5.00

// The mock usage the fake ChatProvider will report.
const MOCK_USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 50,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
};

const EXPECTED_DEBIT_CENTS = computeDebitCents(MOCK_USAGE, MODEL, DEFAULT_MARKUP_BPS);

// ---------------------------------------------------------------------------
// In-memory SessionStore
// ---------------------------------------------------------------------------

function makeMemorySessionStore(): SessionStore {
  const sessions = new Map<string, GatewaySession>();
  let counter = 0;
  return {
    async createSession(input) {
      const session: GatewaySession = {
        sessionId: `sess_smoke_${++counter}`,
        userId: input.userId,
        kitId: input.kitId,
        kitSlug: input.kitSlug,
        systemPromptRef: input.systemPromptRef,
        billingMode: input.billingMode,
        byoProviderConfig: input.byoProviderConfig,
        messages: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        expiresAt: input.expiresAt,
      };
      sessions.set(session.sessionId, session);
      return session;
    },
    async getSession(id) {
      return sessions.get(id);
    },
    async appendMessages(input) {
      const s = sessions.get(input.sessionId)!;
      s.messages.push(...input.messages);
      s.updatedAt = input.updatedAt;
      return s;
    },
    async replaceMessages(id, messages, updatedAt) {
      const s = sessions.get(id)!;
      s.messages = messages;
      s.updatedAt = updatedAt;
      return s;
    },
    async setTurnState(id, turnState, updatedAt) {
      const s = sessions.get(id)!;
      s.turnState = turnState;
      s.updatedAt = updatedAt;
      return s;
    },
    async deleteSession(id) {
      sessions.delete(id);
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory CreditLedgerRepository
// ---------------------------------------------------------------------------

interface InMemLedgerState {
  account: CreditAccount;
  holds: Map<string, CreditHold>;
  transactions: CreditTransaction[];
}

function makeMemoryLedger(
  userId: string,
  initialBalanceCents: number
): { ledger: CreditLedgerRepository; state: InMemLedgerState } {
  let holdCounter = 0;
  let txCounter = 0;

  const account: CreditAccount = {
    userId,
    availableBalanceCents: initialBalanceCents,
    heldBalanceCents: 0,
    lifetimeTopupCents: initialBalanceCents,
    updatedAt: "2026-06-18T00:00:00.000Z",
  };
  const holds = new Map<string, CreditHold>();
  const transactions: CreditTransaction[] = [];

  function appendTx(input: RecordTransactionInput): CreditTransaction {
    const tx: CreditTransaction = {
      transactionId: `tx_${++txCounter}`,
      userId: input.userId,
      type: input.type,
      amountCents: input.amountCents,
      createdAt: input.createdAt,
      holdId: input.holdId,
      description: input.description,
      sourceRef: input.sourceRef,
    };
    transactions.push(tx);
    return tx;
  }

  const ledger: CreditLedgerRepository = {
    async getAccount(uid) {
      return uid === userId ? { ...account } : undefined;
    },
    async ensureAccount(uid, now) {
      account.updatedAt = now;
      return { ...account };
    },
    async recordTransaction(input) {
      return appendTx(input);
    },
    async topup(uid, amountCents, now, sourceRef) {
      account.availableBalanceCents += amountCents;
      account.lifetimeTopupCents += amountCents;
      account.updatedAt = now;
      appendTx({ userId: uid, type: "topup", amountCents, createdAt: now, sourceRef });
      return { ...account };
    },
    async debit(uid, amountCents, now, description, sourceRef) {
      if (account.availableBalanceCents < amountCents) {
        throw new Error(`Insufficient balance: have ${account.availableBalanceCents}¢, need ${amountCents}¢`);
      }
      account.availableBalanceCents -= amountCents;
      account.updatedAt = now;
      appendTx({ userId: uid, type: "debit", amountCents, createdAt: now, description, sourceRef });
      return { ...account };
    },
    async reserveHold(uid, maxCostCents, now) {
      if (account.availableBalanceCents < maxCostCents) {
        throw new Error(
          `Insufficient balance for hold: have ${account.availableBalanceCents}¢, need ${maxCostCents}¢`
        );
      }
      account.availableBalanceCents -= maxCostCents;
      account.heldBalanceCents += maxCostCents;
      account.updatedAt = now;
      const holdId = `hold_${++holdCounter}`;
      holds.set(holdId, {
        holdId,
        userId: uid,
        reservedCents: maxCostCents,
        status: "open",
        createdAt: now,
      });
      appendTx({ userId: uid, type: "hold", amountCents: maxCostCents, createdAt: now, holdId });
      return holdId;
    },
    async settleHold(holdId, actualCostCents, now, sourceRef) {
      const hold = holds.get(holdId);
      if (!hold || hold.status !== "open") throw new Error(`Hold ${holdId} not open`);
      const overshoot = hold.reservedCents - actualCostCents;
      hold.status = "settled";
      hold.settledCents = actualCostCents;
      hold.settledAt = now;
      // Release overshoot
      account.heldBalanceCents -= hold.reservedCents;
      account.availableBalanceCents += overshoot;
      account.updatedAt = now;
      appendTx({ userId: hold.userId, type: "debit", amountCents: actualCostCents, createdAt: now, holdId, sourceRef });
      if (overshoot > 0) {
        appendTx({ userId: hold.userId, type: "hold_release", amountCents: overshoot, createdAt: now, holdId });
      }
      return { ...account };
    },
    async releaseHold(holdId, now) {
      const hold = holds.get(holdId);
      if (!hold || hold.status !== "open") throw new Error(`Hold ${holdId} not open`);
      hold.status = "released";
      hold.settledAt = now;
      account.heldBalanceCents -= hold.reservedCents;
      account.availableBalanceCents += hold.reservedCents;
      account.updatedAt = now;
      appendTx({ userId: hold.userId, type: "hold_release", amountCents: hold.reservedCents, createdAt: now, holdId });
      return { ...account };
    },
    async getHold(holdId) {
      return holds.get(holdId);
    },
    async listTransactions(_uid, limit) {
      const sorted = [...transactions].reverse();
      return limit ? sorted.slice(0, limit) : sorted;
    },
    async getFreeMinutesUsed() {
      return 0;
    },
    async consumeFreeActiveMinutes(_uid, _ym, runActiveMinutes) {
      return runActiveMinutes;
    },
  };

  return { ledger, state: { account, holds, transactions } };
}

// ---------------------------------------------------------------------------
// Mock ChatProvider
// ---------------------------------------------------------------------------

/**
 * Emits: two text deltas, a usage event, a done event.
 * Returns the assembled ChatResponse.
 * Records invocation count via a spy so tests can assert it was/wasn't called.
 */
function makeMockChatProvider(spy?: ReturnType<typeof vi.fn>): ChatProvider {
  return {
    providerType: "anthropic" as const,
    async sendMessage(_req: ChatRequest): Promise<ChatResponse> {
      return {
        content: [{ type: "text", text: "Hello from mock" }],
        stopReason: "end_turn",
        usage: MOCK_USAGE,
      };
    },
    async streamMessage(
      _req: ChatRequest,
      onEvent: (event: StreamEvent) => void
    ): Promise<ChatResponse> {
      if (spy) spy();
      onEvent({ type: "text", delta: "Hello " });
      onEvent({ type: "text", delta: "world!" });
      onEvent({ type: "usage", input: MOCK_USAGE.inputTokens, output: MOCK_USAGE.outputTokens, cached: 0 });
      onEvent({ type: "done", stopReason: "end_turn" });
      return {
        content: [{ type: "text", text: "Hello world!" }],
        stopReason: "end_turn",
        usage: MOCK_USAGE,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return "2026-06-18T12:00:00.000Z";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gateway-turn-smoke — Phase 2b runtime + end-to-end turn", () => {
  it("(a) routeGatewayRequest and runStreamingTurn are functions at runtime", () => {
    // Belt-and-suspenders: the module-level guards above already enforced this,
    // but we also surface it as an explicit test result in the vitest output.
    expect(typeof routeGatewayRequest).toBe("function");
    expect(typeof runStreamingTurn).toBe("function");
  });

  it("full managed turn: text streamed, done received, system prompt not leaked, exactly one debit", async () => {
    const USER = "user_smoke_turn";
    const sessions = makeMemorySessionStore();
    const { ledger, state } = makeMemoryLedger(USER, SEED_BALANCE_CENTS);
    const providerSpy = vi.fn();
    const chatProvider = makeMockChatProvider(providerSpy);

    // Create session
    const createRes = await routeGatewayRequest(
      {
        session: { sessions, now },
        turn: {
          chatProvider,
          sessions,
          ledger,
          resolveSystemPrompt: async () => SYSTEM_SECRET,
          now,
          model: MODEL,
          maxTokens: 1024,
        },
        createEmitter: () => ({ emit: () => {}, close: () => {} }),
      },
      { method: "POST", path: "/gateway/sessions", body: { kitId: "kit-smoke", billing: "managed" }, userId: USER }
    );

    expect(createRes.kind).toBe("json");
    if (createRes.kind !== "json") return;
    expect(createRes.status).toBe(201);
    const sessionId = (createRes.body as { sessionId: string }).sessionId;

    // Run a turn via the router, collecting SSE events
    const emittedEvents: StreamEvent[] = [];
    const turnRes = await routeGatewayRequest(
      {
        session: { sessions, now },
        turn: {
          chatProvider,
          sessions,
          ledger,
          resolveSystemPrompt: async () => SYSTEM_SECRET,
          now,
          model: MODEL,
          maxTokens: 1024,
        },
        createEmitter: () => ({
          emit: (ev) => emittedEvents.push(ev),
          close: () => {},
        }),
      },
      {
        method: "POST",
        path: `/gateway/sessions/${sessionId}/turn`,
        body: { userInput: "Hello" },
        userId: USER,
      }
    );

    expect(turnRes.kind).toBe("stream");
    expect(turnRes.status).toBe(200);

    // (b) Text deltas were emitted
    const textEvents = emittedEvents.filter((e): e is { type: "text"; delta: string } => e.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);
    const assembled = textEvents.map((e) => e.delta).join("");
    expect(assembled).toBe("Hello world!");

    // (c) Done event arrived
    const doneEvents = emittedEvents.filter((e) => e.type === "done");
    expect(doneEvents.length).toBe(1);
    expect((doneEvents[0] as { type: "done"; stopReason: string }).stopReason).toBe("end_turn");

    // (d) System prompt NEVER emitted to client
    const allSerialized = JSON.stringify(emittedEvents);
    expect(allSerialized).not.toContain(SYSTEM_SECRET);

    // (e) Exactly ONE debit transaction recorded
    const debits = state.transactions.filter((tx) => tx.type === "debit");
    expect(debits).toHaveLength(1);
    expect(debits[0].amountCents).toBe(EXPECTED_DEBIT_CENTS);

    // Balance dropped by exactly the debited amount (hold overshoot returned)
    const finalBalance = state.account.availableBalanceCents;
    expect(finalBalance).toBe(SEED_BALANCE_CENTS - EXPECTED_DEBIT_CENTS);

    // Provider was called exactly once (one round-trip)
    expect(providerSpy).toHaveBeenCalledTimes(1);
  });

  it("insufficient-balance: pre-rejects with InsufficientCreditsError, provider never called", async () => {
    const USER = "user_smoke_broke";
    const sessions = makeMemorySessionStore();
    // Seed $0
    const { ledger } = makeMemoryLedger(USER, 0);
    const providerSpy = vi.fn();
    const chatProvider = makeMockChatProvider(providerSpy);

    // Create session
    const createRes = await routeGatewayRequest(
      {
        session: { sessions, now },
        turn: {
          chatProvider,
          sessions,
          ledger,
          resolveSystemPrompt: async () => "irrelevant",
          now,
          model: MODEL,
          maxTokens: 1024,
        },
        createEmitter: () => ({ emit: () => {}, close: () => {} }),
      },
      { method: "POST", path: "/gateway/sessions", body: { kitId: "kit-smoke-broke", billing: "managed" }, userId: USER }
    );
    expect(createRes.kind).toBe("json");
    if (createRes.kind !== "json") return;
    const sessionId = (createRes.body as { sessionId: string }).sessionId;

    // Drive turn — expect a 402 JSON response (pre-stream rejection)
    const events: StreamEvent[] = [];
    const turnRes = await routeGatewayRequest(
      {
        session: { sessions, now },
        turn: {
          chatProvider,
          sessions,
          ledger,
          resolveSystemPrompt: async () => "irrelevant",
          now,
          model: MODEL,
          maxTokens: 1024,
        },
        createEmitter: () => ({
          emit: (ev) => events.push(ev),
          close: () => {},
        }),
      },
      {
        method: "POST",
        path: `/gateway/sessions/${sessionId}/turn`,
        body: { userInput: "Hello" },
        userId: USER,
      }
    );

    // Router maps InsufficientCreditsError → 402 JSON before any provider call
    expect(turnRes.kind).toBe("json");
    expect(turnRes.status).toBe(402);
    const errBody = (turnRes as { kind: "json"; status: number; body: unknown }).body as {
      error: string;
    };
    expect(errBody.error).toBe("insufficient_credits");

    // No events emitted (stream never opened)
    expect(events).toHaveLength(0);

    // Provider was never called
    expect(providerSpy).not.toHaveBeenCalled();
  });

  it("runStreamingTurn directly: same assertions via the service layer", async () => {
    const USER = "user_smoke_direct";
    const sessions = makeMemorySessionStore();
    const { ledger, state } = makeMemoryLedger(USER, SEED_BALANCE_CENTS);
    const chatProvider = makeMockChatProvider();

    // Create a session manually
    const session = await sessions.createSession({
      userId: USER,
      kitId: "kit-direct",
      kitSlug: "kit-direct",
      systemPromptRef: "",
      billingMode: "managed",
      byoProviderConfig: null,
      createdAt: now(),
      expiresAt: Math.floor(Date.now() / 1000) + 14400,
    });

    const emittedEvents: StreamEvent[] = [];
    const result = await runStreamingTurn(
      {
        chatProvider,
        sessions,
        ledger,
        resolveSystemPrompt: async () => SYSTEM_SECRET,
        now,
        model: MODEL,
        maxTokens: 1024,
      },
      session.sessionId,
      { userInput: "Hi directly" },
      (ev) => emittedEvents.push(ev)
    );

    // Turn completed naturally
    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("end_turn");

    // (b) text deltas present
    const textEvents = emittedEvents.filter((e) => e.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);

    // (c) done event arrived
    expect(emittedEvents.some((e) => e.type === "done")).toBe(true);

    // (d) system prompt not in events
    expect(JSON.stringify(emittedEvents)).not.toContain(SYSTEM_SECRET);

    // (e) debit recorded, balance reduced
    const debits = state.transactions.filter((tx) => tx.type === "debit");
    expect(debits).toHaveLength(1);
    expect(debits[0].amountCents).toBe(EXPECTED_DEBIT_CENTS);
    expect(state.account.availableBalanceCents).toBe(SEED_BALANCE_CENTS - EXPECTED_DEBIT_CENTS);

    // debitedCents matches what computeDebitCents would give
    expect(result.debitedCents).toBe(EXPECTED_DEBIT_CENTS);
  });

  it("runStreamingTurn directly with $0 balance: throws InsufficientCreditsError before provider call", async () => {
    const USER = "user_smoke_direct_broke";
    const sessions = makeMemorySessionStore();
    const { ledger } = makeMemoryLedger(USER, 0);
    const providerSpy = vi.fn();
    const chatProvider = makeMockChatProvider(providerSpy);

    const session = await sessions.createSession({
      userId: USER,
      kitId: "kit-direct-broke",
      kitSlug: "kit-direct-broke",
      systemPromptRef: "",
      billingMode: "managed",
      byoProviderConfig: null,
      createdAt: now(),
      expiresAt: Math.floor(Date.now() / 1000) + 14400,
    });

    await expect(
      runStreamingTurn(
        {
          chatProvider,
          sessions,
          ledger,
          resolveSystemPrompt: async () => "irrelevant",
          now,
          model: MODEL,
          maxTokens: 1024,
        },
        session.sessionId,
        { userInput: "Hi" },
        () => {}
      )
    ).rejects.toThrow(InsufficientCreditsError);

    // Provider never called
    expect(providerSpy).not.toHaveBeenCalled();
  });
});
