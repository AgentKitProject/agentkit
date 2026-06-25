/**
 * Applies the SQL migrations in db/migrations/ against DATABASE_URL.
 *
 * Idempotent: every migration uses `IF NOT EXISTS`, so re-running is a no-op.
 * Safe to run as a Kubernetes Job (init/pre-deploy). A session-level advisory
 * lock serializes concurrent runs across replicas, mirroring agentkitmarket-core.
 *
 * Run: node --experimental-strip-types scripts/migrate.mts
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const SCHEMA_LOCK_KEY = 901234;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run migrations.");
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, "..", "db", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const ssl =
    (process.env.PROFILE_DB_SSL ?? "").trim().toLowerCase() === "disable" ||
    /[?&]sslmode=disable\b/.test(connectionString)
      ? false
      : { rejectUnauthorized: false };

  const pool = new Pool({ connectionString, ssl });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK_KEY]);
    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      process.stdout.write(`Applying ${file}...\n`);
      await client.query(sql);
    }
    process.stdout.write(`Applied ${files.length} migration(s).\n`);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK_KEY]).catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
