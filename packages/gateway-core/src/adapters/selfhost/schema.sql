-- AgentKit Gateway Core — self-host Postgres schema
-- Run once at container startup (idempotent: all CREATE TABLE IF NOT EXISTS).
-- Design mirrors agentkitmarket-core schema patterns.
--
-- The managed credit-ledger tables (gateway_credit_accounts / _txns / _holds)
-- live in the commercial package's schema. This public schema covers only the
-- session store needed by the free / BYO path.
--
-- Sessions have a TTL (~4 hours). A scheduled sweep or application-level lazy
-- DELETE handles expired rows (no pg_cron dependency required).

-- ---------------------------------------------------------------------------
-- Gateway sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_sessions (
  session_id          TEXT        NOT NULL PRIMARY KEY,
  user_id             TEXT        NOT NULL,
  kit_id              TEXT        NOT NULL,
  kit_slug            TEXT        NOT NULL,
  system_prompt_ref   TEXT        NOT NULL,
  billing_mode        TEXT        NOT NULL,  -- managed|byo
  byo_provider_config JSONB,                 -- null for managed mode
  messages            JSONB       NOT NULL DEFAULT '[]',
  -- In-flight turn state (credit hold, accumulated usage, pending tool calls).
  -- Null when the session has no active turn (idle).
  turn_state          JSONB,
  created_at          TEXT        NOT NULL,
  updated_at          TEXT        NOT NULL,
  -- Unix epoch seconds; rows past this are expired
  expires_at          BIGINT      NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gateway_sessions_user
  ON gateway_sessions (user_id, created_at DESC);

-- Index for efficient expired-row sweeps. A plain index on expires_at (NOT a
-- partial index) — a predicate referencing now() is rejected by Postgres
-- ("functions in index predicate must be marked IMMUTABLE"), and the sweep query
-- (DELETE ... WHERE expires_at < $now) uses this index regardless.
CREATE INDEX IF NOT EXISTS idx_gateway_sessions_expired
  ON gateway_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Seller-earnings ledger (premium / per-invocation kit royalties)
-- ---------------------------------------------------------------------------
-- A payee-accrual concept alongside the buyer credit ledger. When a PREMIUM
-- (per-invocation) kit run settles as billable, the seller-set per-run royalty
-- is accrued to the SELLING org, net of the platform commission. INERT for
-- self-host / open-core: nothing writes here unless a premium royalty > 0 runs.

-- Append-only event, one per accrued run royalty. Idempotent on source_ref
-- (`royalty-${runId}`): a re-settled / retried run inserts at most once.
CREATE TABLE IF NOT EXISTS gateway_seller_earning_events (
  event_id         TEXT     NOT NULL PRIMARY KEY,
  source_ref       TEXT     NOT NULL UNIQUE,   -- royalty-${runId}
  org_id           TEXT     NOT NULL,
  kit_id           TEXT     NOT NULL,
  run_id           TEXT     NOT NULL,
  gross_cents      BIGINT   NOT NULL,
  commission_cents BIGINT   NOT NULL,
  net_cents        BIGINT   NOT NULL,
  created_at       TEXT     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gateway_seller_earning_events_org
  ON gateway_seller_earning_events (org_id, created_at DESC);

-- Per-org running totals of accrued vs. transferred (paid-out) earnings.
CREATE TABLE IF NOT EXISTS gateway_seller_earnings (
  org_id           TEXT     NOT NULL PRIMARY KEY,
  accrued_cents    BIGINT   NOT NULL DEFAULT 0,
  transferred_cents BIGINT  NOT NULL DEFAULT 0,
  updated_at       TEXT     NOT NULL
);

-- Idempotency ledger for payouts (markSellerEarningsTransferred): a replayed
-- transferRef inserts at most once, so transferred_cents is bumped once.
CREATE TABLE IF NOT EXISTS gateway_seller_earning_transfers (
  transfer_ref     TEXT     NOT NULL PRIMARY KEY,
  org_id           TEXT     NOT NULL,
  amount_cents     BIGINT   NOT NULL,
  created_at       TEXT     NOT NULL
);

-- ---------------------------------------------------------------------------
-- Schema version marker (for future migrations)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_schema_version (
  version     INTEGER     NOT NULL PRIMARY KEY,
  applied_at  TEXT        NOT NULL
);

-- Use a static ISO timestamp for pg-mem compatibility (to_char is not supported by pg-mem).
-- Real Postgres deployments can tolerate this; it's stamped once at first schema run.
-- v2 adds the seller-earnings ledger tables above.
INSERT INTO gateway_schema_version (version, applied_at)
  VALUES (1, '2026-01-01T00:00:00Z'), (2, '2026-07-04T00:00:00Z')
  ON CONFLICT (version) DO NOTHING;
