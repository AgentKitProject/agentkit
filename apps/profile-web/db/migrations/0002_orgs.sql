-- AgentKitProfile org tables (Profile becomes the system of record for orgs).
--
-- Ported VERBATIM from agentkitmarket-core's self-host schema (organizations,
-- org_memberships, org_invites, org_provider_keys, org_run_budgets) with the kit
-- coupling dropped: Profile has no `kits` table, so `kits.owner_org_id` /
-- `kits.visibility` and the `kits_owner_org_id_idx` index are intentionally NOT
-- defined here — kit ownership/visibility stay in Market (see P0 design §0).
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS) so the migrate Job can re-run.

-- === Organizations ============================================================

CREATE TABLE IF NOT EXISTS organizations (
  org_id                 text PRIMARY KEY,
  slug                   text NOT NULL,
  display_name           text NOT NULL,
  type                   text NOT NULL,
  owner_user_id          text NOT NULL,
  handle                 text,
  avatar_initials        text,
  verified               boolean,
  workos_organization_id text,
  -- NOTE: Stripe Connect seller-payout columns stay in the COMMERCIAL Market
  -- schema; Profile (open identity) omits them.
  created_at             text NOT NULL,
  updated_at             text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_uidx ON organizations (slug);
CREATE INDEX IF NOT EXISTS organizations_owner_user_id_idx ON organizations (owner_user_id);

CREATE TABLE IF NOT EXISTS org_memberships (
  org_id             text NOT NULL,
  user_id            text NOT NULL,
  role               text NOT NULL,
  status             text NOT NULL,
  invited_by_user_id text,
  created_at         text NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS org_memberships_user_id_idx ON org_memberships (user_id);

CREATE TABLE IF NOT EXISTS org_invites (
  org_id             text NOT NULL,
  user_id            text NOT NULL,
  email              text,
  role               text NOT NULL,
  invited_by_user_id text NOT NULL,
  created_at         text NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS org_invites_user_id_idx ON org_invites (user_id);

-- Email-invite claim (pre-signup invites): lookups by email on first login.
CREATE INDEX IF NOT EXISTS org_invites_email_idx ON org_invites (email) WHERE email IS NOT NULL;

-- Org shared LLM API keys (encrypted at rest). One key PER provider; composite PK
-- (org_id, provider_type). `api_key_ciphertext` is the opaque at-rest value (the
-- handler layer encrypts/decrypts it — the store only ever sees ciphertext).
CREATE TABLE IF NOT EXISTS org_provider_keys (
  org_id              text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  provider_type       text NOT NULL,
  api_key_ciphertext  text NOT NULL,
  base_url            text,
  updated_by_user_id  text NOT NULL,
  updated_at          text NOT NULL,
  PRIMARY KEY (org_id, provider_type)
);

-- Org default per-run budget (Auto per-run cap override). At most ONE row per org
-- (PK org_id). When set it overrides each member's own default.
CREATE TABLE IF NOT EXISTS org_run_budgets (
  org_id              text PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
  budget_cents        integer NOT NULL,
  updated_by_user_id  text NOT NULL,
  updated_at          text NOT NULL
);
