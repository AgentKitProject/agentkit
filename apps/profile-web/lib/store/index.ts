import "server-only";
import { Pool } from "pg";
import { PostgresProfileStore } from "@/lib/store/postgres-store";
import type { ProfileStore } from "@/lib/store/store";

export type { Profile, ProfileStore, PublicProfile, FullProfileResponse, Role } from "@/lib/store/store";
export { HandleTakenError, toPublicProfile, toFullProfileResponse } from "@/lib/store/store";

let cachedStore: ProfileStore | undefined;
let cachedPool: Pool | undefined;

/**
 * Returns the process-wide ProfileStore. Defaults to Postgres; `PROFILE_STORE`
 * is reserved for future backends but only Postgres is implemented — any other
 * value throws a clear error (there is intentionally no DynamoDB adapter; this
 * deployment is Postgres-only and has no data to migrate).
 */
export function getProfileStore(): ProfileStore {
  if (cachedStore) {
    return cachedStore;
  }

  const backend = (process.env.PROFILE_STORE ?? "postgres").trim().toLowerCase();
  if (backend !== "postgres" && backend !== "") {
    throw new Error(
      `Unsupported PROFILE_STORE "${backend}". Only "postgres" is implemented (this deployment is Postgres-only).`,
    );
  }

  cachedStore = new PostgresProfileStore(getPool());
  return cachedStore;
}

function getPool(): Pool {
  if (cachedPool) {
    return cachedPool;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the Postgres profile store.");
  }

  cachedPool = new Pool({ connectionString, ssl: resolveSsl(connectionString) });
  return cachedPool;
}

/**
 * Enable TLS unless explicitly disabled (`sslmode=disable` or
 * `PROFILE_DB_SSL=disable`). In-cluster Postgres typically uses a self-signed
 * cert, so we don't reject unauthorized chains when SSL is on.
 */
function resolveSsl(connectionString: string): { rejectUnauthorized: boolean } | false {
  const disabledByEnv = (process.env.PROFILE_DB_SSL ?? "").trim().toLowerCase() === "disable";
  const disabledByUrl = /[?&]sslmode=disable\b/.test(connectionString);
  if (disabledByEnv || disabledByUrl) {
    return false;
  }
  return { rejectUnauthorized: false };
}
