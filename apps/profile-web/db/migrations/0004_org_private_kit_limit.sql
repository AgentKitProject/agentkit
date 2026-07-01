-- AgentKitProfile private-kits A2 — per-org max private-kit count.
--
-- ADDITIVE to 0003_org_monthly_limits.sql: reuses the org_monthly_limits row for
-- storage convenience (one org-limits row per org). max_private_kits is NULLABLE
-- (null = unlimited / no org-configured cap). market-core enforces it at
-- set-private time with precedence: org cap → env default → unlimited.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) so the migrate Job can re-run.

ALTER TABLE org_monthly_limits ADD COLUMN IF NOT EXISTS max_private_kits integer;
