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

-- Partial index for efficient expired-row sweeps.
CREATE INDEX IF NOT EXISTS idx_gateway_sessions_expired
  ON gateway_sessions (expires_at)
  WHERE expires_at < EXTRACT(EPOCH FROM now())::BIGINT;

-- ---------------------------------------------------------------------------
-- Schema version marker (for future migrations)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_schema_version (
  version     INTEGER     NOT NULL PRIMARY KEY,
  applied_at  TEXT        NOT NULL
);

-- Use a static ISO timestamp for pg-mem compatibility (to_char is not supported by pg-mem).
-- Real Postgres deployments can tolerate this; it's stamped once at first schema run.
INSERT INTO gateway_schema_version (version, applied_at)
  VALUES (1, '2026-01-01T00:00:00Z')
  ON CONFLICT (version) DO NOTHING;
