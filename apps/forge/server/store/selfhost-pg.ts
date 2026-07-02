// Shared Postgres plumbing for the self-host adapters.
//
// Mirrors the Market self-host pattern (agentkitmarket-core/src/adapters/
// selfhost): a minimal structural Pool type so consumers that only use the AWS
// adapter don't need `pg` at type-check time and pg-mem satisfies it directly,
// plus an idempotent CREATE TABLE IF NOT EXISTS schema run once on startup.
//
// Three tables:
//   kit_metadata   (user_id, kit_id) PK — owned-kit metadata rows
//   user_settings  (user_id) PK         — per-user settings jsonb (keys
//                                          AES-256-GCM encrypted before write)
//   kit_usage      (user_id) PK         — per-account kit-count + byte counters
// Kit FILE TREES live in MinIO/S3 (see s3-tree.ts), NOT in Postgres.

export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
export interface PgPool extends PgQueryable {
  end?: () => Promise<void>;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kit_metadata (
  user_id     text NOT NULL,
  kit_id      text NOT NULL,
  name        text,
  source      text NOT NULL,
  created_at  text NOT NULL,
  updated_at  text NOT NULL,
  PRIMARY KEY (user_id, kit_id)
);
CREATE INDEX IF NOT EXISTS kit_metadata_user_updated_idx
  ON kit_metadata (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id   text PRIMARY KEY,
  settings  jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS kit_usage (
  user_id    text PRIMARY KEY,
  kit_count  bigint NOT NULL DEFAULT 0,
  bytes      bigint NOT NULL DEFAULT 0
);
`;

let ensured = new WeakSet<object>();

/** Idempotently create the schema. Safe to call on every adapter construction. */
export async function ensureSchema(pool: PgPool): Promise<void> {
  if (ensured.has(pool)) return;
  await pool.query(SCHEMA_SQL);
  ensured.add(pool);
}

/** Reset the per-pool "ensured" memo (test helper). */
export function __resetEnsured(): void {
  ensured = new WeakSet<object>();
}
