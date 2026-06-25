/**
 * In-memory test fakes for the gateway core ports.
 *
 *   InMemoryLedger        — re-export of the production InMemoryCreditLedgerRepository
 *                           (correct two-phase-hold semantics + never-negative).
 *   InMemorySessionStore  — append-only messages + turn-state persistence.
 *
 * These mirror the real adapters' observable behaviour so service/router tests
 * exercise the same control flow without infrastructure.
 */

import type { SessionStore } from "../src/core/ports.js";
import type {
  AppendSessionMessagesInput,
  ConversationMessage,
  CreateSessionInput,
  GatewaySession,
  TurnState,
} from "../src/core/types.js";
import { InMemoryCreditLedgerRepository } from "../src/adapters/memory/credit-ledger.js";

// The free/BYO-path production ledger doubles as the test ledger.
export { InMemoryCreditLedgerRepository as InMemoryLedger };

export class InMemorySessionStore implements SessionStore {
  sessions = new Map<string, GatewaySession>();
  private seq = 0;

  async createSession(input: CreateSessionInput): Promise<GatewaySession> {
    const sessionId = `sess-${++this.seq}`;
    const session: GatewaySession = {
      sessionId,
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
    this.sessions.set(sessionId, session);
    return structuredClone(session);
  }

  async getSession(sessionId: string): Promise<GatewaySession | undefined> {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    if (s.expiresAt < Math.floor(Date.now() / 1000)) return undefined;
    return structuredClone(s);
  }

  async appendMessages(input: AppendSessionMessagesInput): Promise<GatewaySession> {
    const s = this.sessions.get(input.sessionId);
    if (!s) throw new Error(`Session not found: ${input.sessionId}`);
    s.messages = [...s.messages, ...input.messages];
    s.updatedAt = input.updatedAt;
    return structuredClone(s);
  }

  async replaceMessages(sessionId: string, messages: ConversationMessage[], updatedAt: string): Promise<GatewaySession> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session not found: ${sessionId}`);
    s.messages = [...messages];
    s.updatedAt = updatedAt;
    return structuredClone(s);
  }

  async setTurnState(sessionId: string, turnState: TurnState, updatedAt: string): Promise<GatewaySession> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session not found: ${sessionId}`);
    s.turnState = structuredClone(turnState);
    s.updatedAt = updatedAt;
    return structuredClone(s);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
