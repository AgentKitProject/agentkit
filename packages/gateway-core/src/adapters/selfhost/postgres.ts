/**
 * Postgres self-host adapter for the gateway core.
 *
 * Implements:
 *   - SessionStore            over Postgres (lazy expiry on read)
 *
 * (The managed Postgres credit ledger lives in the commercial package;
 *  this public adapter provides session storage for the self-hosted runtime.)
 *
 * Uses the standard `pg` Pool interface — no ORM, raw SQL.
 * The schema is in schema.sql (loaded at container startup).
 */

import { randomUUID } from "node:crypto";
import type { SessionStore } from "../../core/ports.js";
import type {
  AppendSessionMessagesInput,
  ConversationMessage,
  CreateSessionInput,
  GatewaySession,
  TurnState,
} from "../../core/types.js";

// ---------------------------------------------------------------------------
// PgPool minimal interface (mirrors agentkitmarket-core pattern)
// ---------------------------------------------------------------------------

export interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToSession(row: Record<string, unknown>): GatewaySession {
  return {
    sessionId: row["session_id"] as string,
    userId: row["user_id"] as string,
    kitId: row["kit_id"] as string,
    kitSlug: row["kit_slug"] as string,
    systemPromptRef: row["system_prompt_ref"] as string,
    billingMode: row["billing_mode"] as GatewaySession["billingMode"],
    byoProviderConfig: row["byo_provider_config"] as GatewaySession["byoProviderConfig"],
    messages: row["messages"] as ConversationMessage[],
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
    expiresAt: row["expires_at"] as number,
    turnState: (row["turn_state"] as TurnState | null | undefined) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Postgres Session Store
// ---------------------------------------------------------------------------

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: PgPool) {}

  async createSession(input: CreateSessionInput): Promise<GatewaySession> {
    const sessionId = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO gateway_sessions
         (session_id, user_id, kit_id, kit_slug, system_prompt_ref,
          billing_mode, byo_provider_config, messages, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
       RETURNING *`,
      [
        sessionId,
        input.userId,
        input.kitId,
        input.kitSlug,
        input.systemPromptRef,
        input.billingMode,
        input.byoProviderConfig ? JSON.stringify(input.byoProviderConfig) : null,
        JSON.stringify([]),
        input.createdAt,
        input.expiresAt,
      ],
    );
    return rowToSession(rows[0]!);
  }

  async getSession(sessionId: string): Promise<GatewaySession | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM gateway_sessions WHERE session_id = $1",
      [sessionId],
    );
    if (!rows[0]) return undefined;
    const session = rowToSession(rows[0]);
    // Lazy expiry check.
    if (session.expiresAt < Math.floor(Date.now() / 1000)) return undefined;
    return session;
  }

  async appendMessages(input: AppendSessionMessagesInput): Promise<GatewaySession> {
    const { rows } = await this.pool.query(
      `UPDATE gateway_sessions
         SET messages   = messages || $2::jsonb,
             updated_at = $3
       WHERE session_id = $1
       RETURNING *`,
      [input.sessionId, JSON.stringify(input.messages), input.updatedAt],
    );
    if (!rows[0]) throw new Error(`Session not found: ${input.sessionId}`);
    return rowToSession(rows[0]);
  }

  async replaceMessages(
    sessionId: string,
    messages: ConversationMessage[],
    updatedAt: string,
  ): Promise<GatewaySession> {
    const { rows } = await this.pool.query(
      `UPDATE gateway_sessions
         SET messages   = $2::jsonb,
             updated_at = $3
       WHERE session_id = $1
       RETURNING *`,
      [sessionId, JSON.stringify(messages), updatedAt],
    );
    if (!rows[0]) throw new Error(`Session not found: ${sessionId}`);
    return rowToSession(rows[0]);
  }

  async setTurnState(
    sessionId: string,
    turnState: TurnState,
    updatedAt: string,
  ): Promise<GatewaySession> {
    const { rows } = await this.pool.query(
      `UPDATE gateway_sessions
         SET turn_state = $2::jsonb,
             updated_at = $3
       WHERE session_id = $1
       RETURNING *`,
      [sessionId, JSON.stringify(turnState), updatedAt],
    );
    if (!rows[0]) throw new Error(`Session not found: ${sessionId}`);
    return rowToSession(rows[0]);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM gateway_sessions WHERE session_id = $1", [sessionId]);
  }
}
