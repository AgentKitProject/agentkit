-- AgentKitProfile org budgets v2 — monthly limits + usage accumulation.
--
-- ADDITIVE to 0002_orgs.sql's per-run budget (org_run_budgets), which is left
-- untouched. This adds two MONTHLY caps, each in TWO units (US cents AND
-- active-minutes): a per-member monthly ceiling and an org-wide monthly pool.
-- Every limit column is NULLABLE (null = unlimited for that unit/scope). Usage is
-- accumulated per (org, member, UTC month). Applies on self-host AND hosted.
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS) so the migrate Job can re-run.

-- Org monthly limits. At most ONE row per org (PK org_id). All four caps are
-- nullable: a null column means that unit/scope is unlimited.
CREATE TABLE IF NOT EXISTS org_monthly_limits (
  org_id              text PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
  pool_cents          integer,
  pool_minutes        integer,
  member_cap_cents    integer,
  member_cap_minutes  integer,
  updated_by_user_id  text NOT NULL,
  updated_at          text NOT NULL
);

-- Accumulated usage per (org, member, period). `period` is a UTC month (YYYY-MM).
-- spent_cents + active_minutes are running totals incremented at run time.
CREATE TABLE IF NOT EXISTS org_usage (
  org_id          text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  user_id         text NOT NULL,
  period          text NOT NULL,
  spent_cents     integer NOT NULL DEFAULT 0,
  -- numeric (not integer): a run's active time is fractional minutes; usage is a
  -- running fractional total. Caps (member_cap_minutes / pool_minutes) stay
  -- integer (whole-minute ceilings). The store reads this via Number(...).
  active_minutes  numeric NOT NULL DEFAULT 0,
  updated_at      text NOT NULL,
  PRIMARY KEY (org_id, user_id, period)
);

-- Aggregation path for the org-wide pool total + per-member breakdown for a period.
CREATE INDEX IF NOT EXISTS org_usage_org_period_idx ON org_usage (org_id, period);
