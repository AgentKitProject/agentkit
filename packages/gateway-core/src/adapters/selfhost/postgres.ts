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
  AccrueRoyaltyInput,
  AppendSessionMessagesInput,
  ConversationMessage,
  CreateSessionInput,
  GatewaySession,
  PendingSellerEarnings,
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

// ---------------------------------------------------------------------------
// Postgres Seller-Earnings Repository (premium / per-invocation kit royalties)
// ---------------------------------------------------------------------------

/**
 * The seller-earnings ledger: a payee-accrual store alongside the buyer credit
 * ledger. `accrueRoyalty` records a premium-kit run's royalty (net of the
 * platform commission) to the SELLING org; a P2 payout job reads the pending
 * balances (`getPendingSellerEarnings`) and marks payouts
 * (`markSellerEarningsTransferred`). All three ops are idempotent by
 * source_ref / transfer_ref, so a retry is a no-op.
 *
 * INERT for open-core / self-host: nothing calls `accrueRoyalty` unless a
 * premium royalty > 0 actually runs.
 *
 * ATOMICITY: `accrueRoyalty` / `markSellerEarningsTransferred` use a
 * data-modifying CTE (`WITH ins AS (INSERT ... RETURNING) INSERT ... FROM ins`)
 * so the idempotent event/transfer insert and the running-total upsert commit as
 * a single statement — no partial write on a retry. (This is a real-Postgres
 * feature; the in-memory `InMemoryCreditLedgerRepository` is the tested reference
 * implementation — pg-mem cannot execute a data-modifying CTE, so this class is
 * verified against a real Postgres, not in the unit suite.)
 */
export class PostgresSellerEarningsRepository {
  constructor(private readonly pool: PgPool) {}

  async accrueRoyalty(input: AccrueRoyaltyInput): Promise<void> {
    const { orgId, kitId, runId, grossRoyaltyCents, commissionBps, now } = input;
    // No-op on a non-positive gross royalty (the premium path also guards this).
    if (!(grossRoyaltyCents > 0)) return;

    const commissionCents = Math.floor((grossRoyaltyCents * Math.max(0, commissionBps)) / 10000);
    const netCents = grossRoyaltyCents - commissionCents;
    const sourceRef = `royalty-${runId}`;
    const eventId = randomUUID();

    // Single-statement, atomic accrual: insert the event (idempotent on
    // source_ref) and, ONLY when the event is newly inserted, upsert the org's
    // accrued total. A CTE keeps both in one transaction; a replayed run inserts
    // nothing and therefore bumps nothing.
    await this.pool.query(
      `WITH ins AS (
         INSERT INTO gateway_seller_earning_events
           (event_id, source_ref, org_id, kit_id, run_id,
            gross_cents, commission_cents, net_cents, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (source_ref) DO NOTHING
         RETURNING org_id, net_cents
       )
       INSERT INTO gateway_seller_earnings (org_id, accrued_cents, transferred_cents, updated_at)
         SELECT org_id, net_cents, 0, $9 FROM ins
       ON CONFLICT (org_id) DO UPDATE
         SET accrued_cents = gateway_seller_earnings.accrued_cents + EXCLUDED.accrued_cents,
             updated_at    = EXCLUDED.updated_at`,
      [eventId, sourceRef, orgId, kitId, runId, grossRoyaltyCents, commissionCents, netCents, now],
    );
  }

  async getPendingSellerEarnings(): Promise<PendingSellerEarnings[]> {
    const { rows } = await this.pool.query(
      `SELECT org_id, (accrued_cents - transferred_cents) AS pending_cents
         FROM gateway_seller_earnings
        WHERE accrued_cents - transferred_cents > 0
        ORDER BY org_id`,
    );
    return rows.map((r) => ({
      orgId: r["org_id"] as string,
      pendingCents: Number(r["pending_cents"]),
    }));
  }

  async markSellerEarningsTransferred(
    orgId: string,
    amountCents: number,
    transferRef: string,
    now: string,
  ): Promise<void> {
    // Idempotent on transfer_ref: record the transfer first; only when it is
    // newly inserted does the org's transferred_cents advance. Same CTE pattern
    // as the accrual — a replayed transferRef inserts nothing and bumps nothing.
    await this.pool.query(
      `WITH ins AS (
         INSERT INTO gateway_seller_earning_transfers
           (transfer_ref, org_id, amount_cents, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (transfer_ref) DO NOTHING
         RETURNING org_id, amount_cents
       )
       INSERT INTO gateway_seller_earnings (org_id, accrued_cents, transferred_cents, updated_at)
         SELECT org_id, 0, amount_cents, $4 FROM ins
       ON CONFLICT (org_id) DO UPDATE
         SET transferred_cents = gateway_seller_earnings.transferred_cents + EXCLUDED.transferred_cents,
             updated_at        = EXCLUDED.updated_at`,
      [transferRef, orgId, amountCents, now],
    );
  }
}
