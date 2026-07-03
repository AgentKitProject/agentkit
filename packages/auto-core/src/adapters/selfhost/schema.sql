-- AgentKitAuto Core — self-host Postgres schema (Phase A).
-- Run once at container startup (idempotent: CREATE TABLE IF NOT EXISTS).
-- Design mirrors agentkitgateway-core / agentkitmarket-core schema patterns.
--
-- Phase A: on-demand autonomous runs only. JSONB columns hold the structured
-- sub-objects (kit_ref, input, result, audit_log) so the row shape matches the
-- AutoRun / AutoApproval domain types without a wide column explosion.

-- ---------------------------------------------------------------------------
-- Auto runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_runs (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  status            TEXT        NOT NULL,   -- queued|running|succeeded|failed|canceled|budget_exceeded
  input             JSONB       NOT NULL,   -- { prompt, files? }
  budget_cents      INTEGER     NOT NULL,   -- REQUIRED per-run budget
  spent_cents       INTEGER     NOT NULL DEFAULT 0,
  -- Billing-model split (see @agentkitforge/auto-core run-driver):
  spent_inference_cents   INTEGER NOT NULL DEFAULT 0,  -- model turns (0 in BYO)
  spent_compute_cents     INTEGER NOT NULL DEFAULT 0,  -- per-minute cloud-run fee
  inference_mode          TEXT    NOT NULL DEFAULT 'managed',  -- managed|byo
  is_cloud_run            BOOLEAN NOT NULL DEFAULT FALSE,
  cloud_run_cents_per_min INTEGER NOT NULL DEFAULT 0,
  model             TEXT        NOT NULL,
  created_at        TEXT        NOT NULL,   -- ISO 8601
  started_at        TEXT,
  finished_at       TEXT,
  result            JSONB,                  -- { output, files[] }
  error             TEXT,
  audit_log         JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- append-only
  workspace_id      TEXT,
  cancel_requested  BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Phase B (scheduled runs): how this run was triggered + the firing schedule.
  trigger           TEXT        NOT NULL DEFAULT 'on_demand',  -- on_demand|schedule|webhook
  schedule_id       TEXT,
  -- Phase C: the firing webhook (trigger='webhook') + staged input-file manifest.
  webhook_id        TEXT,
  input_files       JSONB                   -- AutoRunInputFileRef[] (or NULL)
);

CREATE INDEX IF NOT EXISTS auto_runs_user_idx ON auto_runs (user_id, created_at DESC);

-- Idempotent migration for existing deployments (columns added 2026-06 for the
-- AgentKitAuto billing model). ADD COLUMN IF NOT EXISTS is a no-op when present.
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS spent_inference_cents   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS spent_compute_cents     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS inference_mode          TEXT    NOT NULL DEFAULT 'managed';
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS is_cloud_run            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS cloud_run_cents_per_min INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Auto approvals (standing approvals)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_approvals (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  -- Denormalised matching key (user_id # kitRefKey) for getApprovalForKit.
  user_kit_key      TEXT        NOT NULL,
  scope             TEXT        NOT NULL,   -- workspace_read_write
  tool_allowlist    JSONB       NOT NULL,   -- string[]
  -- Phase C: JSONB NetworkPolicy { mode:'deny_all' } | { mode:'allowlist', hosts:[] }.
  -- Legacy rows may hold the bare string "deny_all"; normalizeNetworkPolicy() copes.
  network_policy    JSONB       NOT NULL,
  max_budget_cents  INTEGER     NOT NULL,
  created_at        TEXT        NOT NULL,
  revoked_at        TEXT
);

CREATE INDEX IF NOT EXISTS auto_approvals_user_idx ON auto_approvals (user_id);
CREATE INDEX IF NOT EXISTS auto_approvals_user_kit_idx ON auto_approvals (user_kit_key);

-- Idempotent migration for existing deployments (Phase B columns).
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS trigger     TEXT NOT NULL DEFAULT 'on_demand';
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS schedule_id TEXT;

-- ---------------------------------------------------------------------------
-- Auto schedules (Phase B — scheduled / cron runs)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_schedules (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  cron              TEXT        NOT NULL,   -- standard 5-field cron
  timezone          TEXT        NOT NULL DEFAULT 'UTC',  -- IANA tz
  input             JSONB       NOT NULL,   -- per-run { prompt, files? }
  budget_cents      INTEGER     NOT NULL,   -- REQUIRED per-run budget
  model             TEXT        NOT NULL,
  approval_id       TEXT        NOT NULL,   -- standing approval this runs under
  inference_mode    TEXT,                   -- managed|byo (NULL = run default)
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TEXT        NOT NULL,   -- ISO 8601
  updated_at        TEXT        NOT NULL,
  last_run_at       TEXT,                   -- ISO of last fire (NULL until first)
  last_run_id       TEXT,                   -- run id of last fire
  next_run_at       TEXT        NOT NULL,   -- ISO of next scheduled fire (due key)
  last_error        TEXT                    -- last skip/dispatch error
);

CREATE INDEX IF NOT EXISTS auto_schedules_user_idx ON auto_schedules (user_id);
-- Due-selection: enabled schedules ordered by next_run_at.
CREATE INDEX IF NOT EXISTS auto_schedules_due_idx ON auto_schedules (enabled, next_run_at);

-- Idempotent migration for existing deployments (Phase C columns).
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS webhook_id  TEXT;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS input_files JSONB;

-- ---------------------------------------------------------------------------
-- Auto webhooks (Phase C — inbound event triggers)
-- ---------------------------------------------------------------------------
-- A webhook fires one autonomous run per inbound HTTP call, gated by a standing
-- approval. SECURITY: only the sha256 HEX HASH of the shared secret is stored;
-- the plaintext is shown to the user once at creation and never persisted.
CREATE TABLE IF NOT EXISTS auto_webhooks (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  approval_id       TEXT        NOT NULL,   -- standing approval this runs under
  budget_cents      INTEGER     NOT NULL,   -- REQUIRED per-fire budget
  model             TEXT        NOT NULL,
  inference_mode    TEXT,                   -- managed|byo (NULL = run default)
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  secret_hash       TEXT        NOT NULL,   -- sha256 hex of the secret (NEVER plaintext)
  created_at        TEXT        NOT NULL,   -- ISO 8601
  last_fired_at     TEXT,                   -- ISO of last fire (NULL until first)
  last_run_id       TEXT,                   -- run id of last fire
  last_error        TEXT,                   -- last auth/skip/dispatch error
  fire_count        INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS auto_webhooks_user_idx ON auto_webhooks (user_id);

-- ---------------------------------------------------------------------------
-- Event-driven expansion: unified triggers + event sources + ring buffers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_triggers (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  type              TEXT        NOT NULL,
  config            JSONB       NOT NULL,
  kit_ref           JSONB       NOT NULL,
  approval_id       TEXT        NOT NULL,
  model             TEXT,
  budget_cents      INTEGER,
  filters           JSONB,
  mapping           JSONB       NOT NULL,
  destinations      JSONB,
  rate_limit        JSONB       NOT NULL,
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  poll_cursor       TEXT,
  circuit_failures  INTEGER     NOT NULL DEFAULT 0,
  circuit_paused_at TEXT,
  created_at        TEXT        NOT NULL,
  updated_at        TEXT        NOT NULL,
  last_fired_at     TEXT,
  last_run_id       TEXT,
  last_error        TEXT,
  fire_count        INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS auto_triggers_user_idx ON auto_triggers (user_id);
CREATE INDEX IF NOT EXISTS auto_triggers_due_idx ON auto_triggers (type, enabled, poll_cursor);

CREATE TABLE IF NOT EXISTS auto_event_sources (
  id                  TEXT      NOT NULL PRIMARY KEY,
  user_id             TEXT      NOT NULL,
  name                TEXT      NOT NULL,
  kind                TEXT      NOT NULL,
  provider            TEXT,
  token_hash          TEXT      NOT NULL,
  has_signing_secret  BOOLEAN   NOT NULL DEFAULT FALSE,
  enabled             BOOLEAN   NOT NULL DEFAULT TRUE,
  created_at          TEXT      NOT NULL,
  last_event_at       TEXT,
  event_count         INTEGER   NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS auto_event_sources_user_idx ON auto_event_sources (user_id);
CREATE INDEX IF NOT EXISTS auto_event_sources_token_idx ON auto_event_sources (token_hash);

CREATE TABLE IF NOT EXISTS auto_received_events (
  id          TEXT        NOT NULL PRIMARY KEY,
  seq         BIGSERIAL,
  source_id   TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  received_at  TEXT       NOT NULL,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS auto_received_events_source_idx ON auto_received_events (source_id, seq);

CREATE TABLE IF NOT EXISTS auto_fire_logs (
  id          TEXT        NOT NULL PRIMARY KEY,
  seq         BIGSERIAL,
  trigger_id  TEXT        NOT NULL,
  fired_at    TEXT        NOT NULL,
  outcome     TEXT        NOT NULL,
  run_id      TEXT,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS auto_fire_logs_trigger_idx ON auto_fire_logs (trigger_id, seq);

-- Idempotent migration: unified-Trigger run provenance (contracts autoRunSchema.triggerId).
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS trigger_id TEXT;

CREATE TABLE IF NOT EXISTS auto_secrets (
  secret_ref  TEXT        NOT NULL PRIMARY KEY,
  ciphertext  TEXT        NOT NULL,
  iv          TEXT        NOT NULL,
  tag         TEXT        NOT NULL,
  created_at  TEXT        NOT NULL
);

ALTER TABLE auto_event_sources ADD COLUMN IF NOT EXISTS signing_secret_ref TEXT;


-- Idempotent migration: persisted-output manifest (contracts autoRunSchema.outputFiles).
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS output_files JSONB;

CREATE TABLE IF NOT EXISTS auto_connections (
  id           TEXT        NOT NULL PRIMARY KEY,
  owner_type   TEXT        NOT NULL,
  owner_id     TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  type         TEXT        NOT NULL,
  config       JSONB       NOT NULL,
  secret_ref   TEXT,
  status       TEXT        NOT NULL DEFAULT 'unverified',
  last_used_at TEXT,
  created_at   TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS auto_connections_owner_idx ON auto_connections (owner_type, owner_id);

CREATE TABLE IF NOT EXISTS auto_pending_approvals (
  id          TEXT        NOT NULL PRIMARY KEY,
  trigger_id  TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  token_hash  TEXT        NOT NULL,
  event_json  TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'pending',
  created_at  TEXT        NOT NULL,
  expires_at  TEXT        NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS auto_pending_approvals_token_idx ON auto_pending_approvals (token_hash);
CREATE INDEX IF NOT EXISTS auto_pending_approvals_trigger_idx ON auto_pending_approvals (trigger_id);
