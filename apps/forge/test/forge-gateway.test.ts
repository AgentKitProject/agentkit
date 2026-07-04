// Forge (bearer) gateway — Phase 2c-i.
//
// Two concerns:
//   1. ROUTE AUTH GATE — POST /api/forge/gateway/sessions with NO bearer returns
//      401 and never touches the session store / ledger (the bearer gate runs
//      first, exactly like the cookie routes' cookie gate). jose is mocked so no
//      network JWKS fetch occurs.
//   2. TURN-WITH-TOOLS SMOKE — drives the gateway-core router with forge-shaped
//      deps (client-provided system context + client-declared tools, decoded the
//      SAME way the production forge composition root does) through a tool-use
//      pause → tool-result → resume → done loop. Asserts:
//        - the tool_call reached the client (a `tool_use`/`done` event carried it)
//        - the system prompt SECRET never crossed to the client (Tier-3 invariant)
//        - resume continues under the same hold to a natural stop (one debit)
import { describe, expect, it, vi } from "vitest";

// --- mock jose so the route's bearer gate runs offline -----------------------
const jwtVerifyMock = vi.fn();
vi.mock("jose", () => ({
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
  createRemoteJWKSet: () => "JWKS_HANDLE"
}));

import {
  routeGatewayRequest,
  createGatewaySession,
  computeDebitCents,
  DEFAULT_MARKUP_BPS,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type CreditAccount,
  type CreditHold,
  type CreditLedgerRepository,
  type CreditTransaction,
  type GatewayRouterDeps,
  type GatewaySession,
  type RecordTransactionInput,
  type SessionStore,
  type StreamEvent,
  type TokenUsage,
  type ToolDefinition
} from "@agentkitforge/gateway-core";

// ---------------------------------------------------------------------------
// (1) Route auth gate
// ---------------------------------------------------------------------------

describe("forge gateway route — bearer auth gate", () => {
  it("POST /api/forge/gateway/sessions without a bearer → 401", async () => {
    const { POST } = await import("@/app/api/forge/gateway/sessions/route");
    const req = new Request("https://forge.example/api/forge/gateway/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ systemPrompt: "hi" })
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_SIGNED_IN");
    // The token was never verified (gate rejected before jose).
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it("POST /api/forge/gateway/sessions with a malformed bearer → 401", async () => {
    const { POST } = await import("@/app/api/forge/gateway/sessions/route");
    const req = new Request("https://forge.example/api/forge/gateway/sessions", {
      method: "POST",
      headers: { authorization: "Basic nope", "content-type": "application/json" },
      body: "{}"
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// (2) Turn-with-tools smoke — forge-shaped deps + tool-use pause/resume loop
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-4-6";
const SYSTEM_SECRET = "FORGE_KIT_SECRET_DO_NOT_LEAK";
const SEED_BALANCE_CENTS = 1000;

const MOCK_USAGE: TokenUsage = {
  inputTokens: 80,
  outputTokens: 40,
  cachedReadTokens: 0,
  cachedWriteTokens: 0
};

// Mirror the production forge composition's ref encoding so resolveSystemPrompt
// / resolveTools read client-provided context off the session — without
// importing the DynamoDB-bound module.
const CONTEXT_REF_PREFIX = "forgectx:v1:";
function encodeCtx(systemPrompt: string, tools: ToolDefinition[]): string {
  return CONTEXT_REF_PREFIX + JSON.stringify({ systemPrompt, tools });
}
function decodeCtx(ref: string): { systemPrompt: string; tools: ToolDefinition[] } | null {
  if (!ref.startsWith(CONTEXT_REF_PREFIX)) return null;
  return JSON.parse(ref.slice(CONTEXT_REF_PREFIX.length));
}

const LOCAL_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a local file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  }
];

function makeMemorySessionStore(): SessionStore {
  const sessions = new Map<string, GatewaySession>();
  let counter = 0;
  return {
    async createSession(input) {
      const session: GatewaySession = {
        sessionId: `forge_sess_${++counter}`,
        userId: input.userId,
        kitId: input.kitId,
        kitSlug: input.kitSlug,
        systemPromptRef: input.systemPromptRef,
        billingMode: input.billingMode,
        byoProviderConfig: input.byoProviderConfig,
        messages: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        expiresAt: input.expiresAt
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
    }
  };
}

function makeMemoryLedger(
  userId: string,
  initialBalanceCents: number
): { ledger: CreditLedgerRepository; transactions: CreditTransaction[] } {
  let holdCounter = 0;
  let txCounter = 0;
  const account: CreditAccount = {
    userId,
    availableBalanceCents: initialBalanceCents,
    heldBalanceCents: 0,
    lifetimeTopupCents: initialBalanceCents,
    updatedAt: "2026-06-18T00:00:00.000Z"
  };
  const holds = new Map<string, CreditHold>();
  const transactions: CreditTransaction[] = [];
  const appendTx = (input: RecordTransactionInput): CreditTransaction => {
    const tx: CreditTransaction = {
      transactionId: `tx_${++txCounter}`,
      userId: input.userId,
      type: input.type,
      amountCents: input.amountCents,
      createdAt: input.createdAt,
      holdId: input.holdId,
      description: input.description,
      sourceRef: input.sourceRef
    };
    transactions.push(tx);
    return tx;
  };
  const ledger: CreditLedgerRepository = {
    async getAccount(uid) {
      return uid === userId ? { ...account } : undefined;
    },
    async ensureAccount(_uid, now) {
      account.updatedAt = now;
      return { ...account };
    },
    async recordTransaction(input) {
      return appendTx(input);
    },
    async topup(uid, amountCents, now, sourceRef) {
      account.availableBalanceCents += amountCents;
      account.updatedAt = now;
      appendTx({ userId: uid, type: "topup", amountCents, createdAt: now, sourceRef });
      return { ...account };
    },
    async debit(uid, amountCents, now, description, sourceRef) {
      account.availableBalanceCents -= amountCents;
      account.updatedAt = now;
      appendTx({ userId: uid, type: "debit", amountCents, createdAt: now, description, sourceRef });
      return { ...account };
    },
    async reserveHold(uid, maxCostCents, now) {
      if (account.availableBalanceCents < maxCostCents) {
        throw new Error(`Insufficient balance for hold`);
      }
      account.availableBalanceCents -= maxCostCents;
      account.heldBalanceCents += maxCostCents;
      account.updatedAt = now;
      const holdId = `hold_${++holdCounter}`;
      holds.set(holdId, { holdId, userId: uid, reservedCents: maxCostCents, status: "open", createdAt: now });
      appendTx({ userId: uid, type: "hold", amountCents: maxCostCents, createdAt: now, holdId });
      return holdId;
    },
    async settleHold(holdId, actualCostCents, now, sourceRef) {
      const hold = holds.get(holdId)!;
      const overshoot = hold.reservedCents - actualCostCents;
      hold.status = "settled";
      hold.settledCents = actualCostCents;
      hold.settledAt = now;
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
      const hold = holds.get(holdId)!;
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
    async listTransactions() {
      return [...transactions].reverse();
    },
    async getFreeMinutesUsed() {
      return 0;
    },
    async consumeFreeActiveMinutes(_uid: string, _ym: string, runActiveMinutes: number) {
      return runActiveMinutes;
    },
    // M6 seller-earnings ledger (no-ops in this fake — forge doesn't accrue royalties).
    async accrueRoyalty() {},
    async getPendingSellerEarnings() {
      return [];
    },
    async markSellerEarningsTransferred() {},
  };
  return { ledger, transactions };
}

/**
 * A mock ChatProvider that, on the FIRST round-trip, emits a `tool_use` block
 * (→ stop_reason "tool_use", pausing the turn); on the SECOND round-trip (after
 * the client returns the tool result) it emits text and stops naturally.
 *
 * It also asserts (via the captured request) that the SYSTEM_SECRET reached the
 * provider but the tools were declared — so we know resolveSystemPrompt /
 * resolveTools wired the client context through.
 */
function makeToolLoopProvider(captured: { requests: ChatRequest[] }): ChatProvider {
  let round = 0;
  return {
    providerType: "anthropic" as const,
    async sendMessage(req: ChatRequest): Promise<ChatResponse> {
      captured.requests.push(req);
      return { content: [{ type: "text", text: "noop" }], stopReason: "end_turn", usage: MOCK_USAGE };
    },
    async streamMessage(req: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<ChatResponse> {
      captured.requests.push(req);
      round += 1;
      if (round === 1) {
        // First round-trip: request a tool call.
        const input = { path: "/tmp/x.txt" };
        onEvent({ type: "tool_use", toolUseId: "toolu_1", name: "read_file", inputComplete: input });
        onEvent({ type: "usage", input: MOCK_USAGE.inputTokens, output: MOCK_USAGE.outputTokens, cached: 0 });
        onEvent({ type: "done", stopReason: "tool_use" });
        return {
          content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input }],
          stopReason: "tool_use",
          usage: MOCK_USAGE
        };
      }
      // Second round-trip: natural completion using the tool result.
      onEvent({ type: "text", delta: "The file says hello." });
      onEvent({ type: "usage", input: MOCK_USAGE.inputTokens, output: MOCK_USAGE.outputTokens, cached: 0 });
      onEvent({ type: "done", stopReason: "end_turn" });
      return {
        content: [{ type: "text", text: "The file says hello." }],
        stopReason: "end_turn",
        usage: MOCK_USAGE
      };
    }
  };
}

function now(): string {
  return "2026-06-18T12:00:00.000Z";
}

function forgeDeps(
  sessions: SessionStore,
  ledger: CreditLedgerRepository,
  chatProvider: ChatProvider,
  events: StreamEvent[]
): GatewayRouterDeps {
  return {
    session: { sessions, now },
    turn: {
      chatProvider,
      sessions,
      ledger,
      // Forge composition's resolvers: read client context off the session ref.
      resolveSystemPrompt: async (s) => decodeCtx(s.systemPromptRef)?.systemPrompt ?? "default",
      resolveTools: async (s) => decodeCtx(s.systemPromptRef)?.tools ?? [],
      now,
      model: MODEL,
      maxTokens: 1024
    },
    createEmitter: () => ({ emit: (ev) => events.push(ev), close: () => {} })
  };
}

describe("forge gateway — turn-with-tools pause/resume smoke", () => {
  it("tool_use pauses the turn, tool-result resumes it, and the system prompt never leaks", async () => {
    const USER = "forge_user_tools";
    const sessions = makeMemorySessionStore();
    const { ledger, transactions } = makeMemoryLedger(USER, SEED_BALANCE_CENTS);
    const captured = { requests: [] as ChatRequest[] };
    const chatProvider = makeToolLoopProvider(captured);

    // Create a forge session carrying client-provided context + declared tools.
    const session = await createGatewaySession(
      { sessions, now },
      {
        userId: USER,
        kitId: "local-kit",
        billing: "managed",
        systemPromptRef: encodeCtx(SYSTEM_SECRET, LOCAL_TOOLS)
      }
    );

    // --- /turn → expect a pause on tool_use -----------------------------------
    const turnEvents: StreamEvent[] = [];
    const turnRes = await routeGatewayRequest(
      forgeDeps(sessions, ledger, chatProvider, turnEvents),
      {
        method: "POST",
        path: `/gateway/sessions/${session.sessionId}/turn`,
        body: { userInput: "read /tmp/x.txt" },
        userId: USER
      }
    );
    expect(turnRes.kind).toBe("stream");

    // The tool_call reached the client.
    const toolUseEvents = turnEvents.filter((e) => e.type === "tool_use");
    expect(toolUseEvents).toHaveLength(1);
    expect((toolUseEvents[0] as { name: string }).name).toBe("read_file");
    // Turn paused (done stopReason tool_use).
    const doneAfterTurn = turnEvents.filter((e) => e.type === "done");
    expect((doneAfterTurn.at(-1) as { stopReason: string }).stopReason).toBe("tool_use");

    // System prompt never crossed to the client.
    expect(JSON.stringify(turnEvents)).not.toContain(SYSTEM_SECRET);
    // …but it DID reach the provider, and the tools were declared.
    expect(captured.requests[0].system).toContain(SYSTEM_SECRET);
    expect(captured.requests[0].tools.map((t) => t.name)).toContain("read_file");

    // --- /tool-result → resume to natural completion --------------------------
    const resumeEvents: StreamEvent[] = [];
    const resumeRes = await routeGatewayRequest(
      forgeDeps(sessions, ledger, chatProvider, resumeEvents),
      {
        method: "POST",
        path: `/gateway/sessions/${session.sessionId}/tool-result`,
        body: { results: [{ toolUseId: "toolu_1", result: "hello" }] },
        userId: USER
      }
    );
    expect(resumeRes.kind).toBe("stream");

    // Text streamed; a natural-stop done arrived.
    const text = resumeEvents
      .filter((e): e is { type: "text"; delta: string } => e.type === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("The file says hello.");
    const doneAfterResume = resumeEvents.filter((e) => e.type === "done");
    expect((doneAfterResume.at(-1) as { stopReason: string }).stopReason).toBe("end_turn");
    expect(JSON.stringify(resumeEvents)).not.toContain(SYSTEM_SECRET);

    // Provider was invoked twice (one round-trip per leg of the loop).
    expect(captured.requests.length).toBe(2);

    // Billing: a single hold backed the whole turn → exactly ONE settled debit.
    const debits = transactions.filter((tx) => tx.type === "debit");
    expect(debits).toHaveLength(1);
    // Two round-trips' usage summed and settled once.
    const summed: TokenUsage = {
      inputTokens: MOCK_USAGE.inputTokens * 2,
      outputTokens: MOCK_USAGE.outputTokens * 2,
      cachedReadTokens: 0,
      cachedWriteTokens: 0
    };
    expect(debits[0].amountCents).toBe(computeDebitCents(summed, MODEL, DEFAULT_MARKUP_BPS));
  });

  it("a forge session with NO declared tools stays conversational (no tool_use)", async () => {
    const USER = "forge_user_conv";
    const sessions = makeMemorySessionStore();
    const { ledger } = makeMemoryLedger(USER, SEED_BALANCE_CENTS);
    const captured = { requests: [] as ChatRequest[] };
    // Provider that only ever emits text (no tools declared → no tool path).
    const chatProvider: ChatProvider = {
      providerType: "anthropic",
      async sendMessage(req) {
        captured.requests.push(req);
        return { content: [{ type: "text", text: "hi" }], stopReason: "end_turn", usage: MOCK_USAGE };
      },
      async streamMessage(req, onEvent) {
        captured.requests.push(req);
        onEvent({ type: "text", delta: "Just chatting." });
        onEvent({ type: "usage", input: MOCK_USAGE.inputTokens, output: MOCK_USAGE.outputTokens, cached: 0 });
        onEvent({ type: "done", stopReason: "end_turn" });
        return { content: [{ type: "text", text: "Just chatting." }], stopReason: "end_turn", usage: MOCK_USAGE };
      }
    };

    const session = await createGatewaySession(
      { sessions, now },
      { userId: USER, kitId: "conv-kit", billing: "managed", systemPromptRef: encodeCtx("be brief", []) }
    );

    const events: StreamEvent[] = [];
    await routeGatewayRequest(forgeDeps(sessions, ledger, chatProvider, events), {
      method: "POST",
      path: `/gateway/sessions/${session.sessionId}/turn`,
      body: { userInput: "hello" },
      userId: USER
    });

    expect(events.some((e) => e.type === "tool_use")).toBe(false);
    // No tools were declared to the provider.
    expect(captured.requests[0].tools).toHaveLength(0);
  });
});
