/**
 * PostgresRoyaltyAccrualStore (M6 #5) over pg-mem — asserts it matches the tested
 * InMemoryRoyaltyAccrualStore reference semantics:
 *   - recordUnaccrued is idempotent on runId (first-write-wins).
 *   - listUnaccrued returns not-yet-accrued rows oldest-first, honoring the limit.
 *   - markAccrued drops the row out of listUnaccrued (idempotent).
 *   - markError records only while still pending; never resurfaces an accrued row.
 *
 * Backed by pg-mem (in-memory Postgres) so no external services / Docker are
 * required — mirrors postgres-repo.test.ts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import {
  PostgresRoyaltyAccrualStore,
  type PgPool,
} from "../src/adapters/selfhost/postgres.js";
import type { UnaccruedRoyalty } from "../src/core/royalty-reconciliation.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(
  join(here, "..", "src", "adapters", "selfhost", "schema.sql"),
  "utf8",
);

function intent(runId: string, over: Partial<UnaccruedRoyalty> = {}): UnaccruedRoyalty {
  return {
    runId,
    orgId: over.orgId ?? "org-1",
    kitId: over.kitId ?? "kit-1",
    grossRoyaltyCents: over.grossRoyaltyCents ?? 250,
    commissionBps: over.commissionBps ?? 600,
  };
}

describe("PostgresRoyaltyAccrualStore (pg-mem)", () => {
  let store: PostgresRoyaltyAccrualStore;

  beforeEach(async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool() as unknown as PgPool;
    await pool.query(schemaSql);
    store = new PostgresRoyaltyAccrualStore(pool);
  });

  it("records and lists a pending intent (round-trips all fields)", async () => {
    await store.recordUnaccrued(intent("run-a"), "2026-01-01T00:00:00Z");
    const pending = await store.listUnaccrued(10);
    expect(pending).toEqual([intent("run-a")]);
  });

  it("recordUnaccrued is idempotent on runId (first-write-wins)", async () => {
    await store.recordUnaccrued(intent("run-a", { grossRoyaltyCents: 250 }), "2026-01-01T00:00:00Z");
    // Re-record the SAME runId with different values → must NOT overwrite or dup.
    await store.recordUnaccrued(intent("run-a", { grossRoyaltyCents: 999 }), "2026-01-02T00:00:00Z");
    const pending = await store.listUnaccrued(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.grossRoyaltyCents).toBe(250);
  });

  it("listUnaccrued returns oldest-first and honors the limit", async () => {
    await store.recordUnaccrued(intent("run-c"), "2026-01-03T00:00:00Z");
    await store.recordUnaccrued(intent("run-a"), "2026-01-01T00:00:00Z");
    await store.recordUnaccrued(intent("run-b"), "2026-01-02T00:00:00Z");
    const all = await store.listUnaccrued(10);
    expect(all.map((r) => r.runId)).toEqual(["run-a", "run-b", "run-c"]);
    const limited = await store.listUnaccrued(2);
    expect(limited.map((r) => r.runId)).toEqual(["run-a", "run-b"]);
  });

  it("markAccrued drops the row out of listUnaccrued and is idempotent", async () => {
    await store.recordUnaccrued(intent("run-a"), "2026-01-01T00:00:00Z");
    await store.recordUnaccrued(intent("run-b"), "2026-01-02T00:00:00Z");
    await store.markAccrued("run-a", "2026-01-05T00:00:00Z");
    expect((await store.listUnaccrued(10)).map((r) => r.runId)).toEqual(["run-b"]);
    // Idempotent: marking again is a no-op.
    await store.markAccrued("run-a", "2026-01-06T00:00:00Z");
    expect((await store.listUnaccrued(10)).map((r) => r.runId)).toEqual(["run-b"]);
    // Unknown runId: harmless no-op.
    await store.markAccrued("nope", "2026-01-06T00:00:00Z");
    expect((await store.listUnaccrued(10)).map((r) => r.runId)).toEqual(["run-b"]);
  });

  it("markError only records while still pending; never resurfaces an accrued row", async () => {
    await store.recordUnaccrued(intent("run-a"), "2026-01-01T00:00:00Z");
    // Pending → error is recorded but the row stays pending (still listed).
    await store.markError("run-a", "gateway 503", "2026-01-02T00:00:00Z");
    expect((await store.listUnaccrued(10)).map((r) => r.runId)).toEqual(["run-a"]);
    // Accrued → a later markError must NOT resurface it (accrued_at set, guarded).
    await store.markAccrued("run-a", "2026-01-03T00:00:00Z");
    await store.markError("run-a", "late error", "2026-01-04T00:00:00Z");
    expect(await store.listUnaccrued(10)).toEqual([]);
  });
});
