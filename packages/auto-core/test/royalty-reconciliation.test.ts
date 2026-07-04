import { describe, it, expect } from "vitest";
import type { AccrueRoyaltyInput } from "@agentkitforge/gateway-core";
import {
  reconcileRoyaltyAccrualsCore,
  InMemoryRoyaltyAccrualStore,
  type UnaccruedRoyalty,
} from "../src/core/royalty-reconciliation.js";

/**
 * M6 #5 — durable royalty-accrual reconciliation. Covers: a queued unaccrued
 * royalty is re-accrued through the idempotent ledger + marked resolved; a
 * transient accrual failure keeps the intent pending (retried on the next run);
 * a per-run failure does not abort the batch; and recordUnaccrued is idempotent.
 */

const NOW = "2026-07-04T00:00:00.000Z";
const silent = { info: () => {}, warn: () => {}, error: () => {} };

function intent(runId: string, over: Partial<UnaccruedRoyalty> = {}): UnaccruedRoyalty {
  return { runId, orgId: "org-1", kitId: "kit-1", grossRoyaltyCents: 500, commissionBps: 600, ...over };
}

describe("royalty reconciliation core", () => {
  it("re-accrues a queued unaccrued royalty (with the SAME runId/gross/commission) and marks it resolved", async () => {
    const store = new InMemoryRoyaltyAccrualStore();
    await store.recordUnaccrued(intent("run-a"), NOW);

    const accrued: AccrueRoyaltyInput[] = [];
    const res = await reconcileRoyaltyAccrualsCore({
      store,
      accrueRoyalty: async (i) => void accrued.push(i),
      now: () => NOW,
      logger: silent,
    });

    expect(res).toMatchObject({ scanned: 1, reconciled: 1, failed: 0 });
    // Accrued with the run's original context (idempotent by runId on the gateway).
    expect(accrued).toEqual([
      { orgId: "org-1", kitId: "kit-1", runId: "run-a", grossRoyaltyCents: 500, commissionBps: 600, now: NOW },
    ]);
    // Resolved → no longer pending.
    expect(await store.listUnaccrued(10)).toEqual([]);
  });

  it("is a clean no-op when nothing is pending", async () => {
    const store = new InMemoryRoyaltyAccrualStore();
    const res = await reconcileRoyaltyAccrualsCore({
      store,
      accrueRoyalty: async () => {
        throw new Error("should not be called");
      },
      now: () => NOW,
      logger: silent,
    });
    expect(res).toMatchObject({ scanned: 0, reconciled: 0, failed: 0 });
  });

  it("keeps the intent PENDING when the accrual retry fails (picked up next run)", async () => {
    const store = new InMemoryRoyaltyAccrualStore();
    await store.recordUnaccrued(intent("run-b"), NOW);

    let attempts = 0;
    const flaky = async () => {
      attempts++;
      if (attempts === 1) throw new Error("gateway 500");
    };

    const first = await reconcileRoyaltyAccrualsCore({ store, accrueRoyalty: flaky, now: () => NOW, logger: silent });
    expect(first).toMatchObject({ scanned: 1, reconciled: 0, failed: 1 });
    expect(first.errors[0]).toMatchObject({ runId: "run-b", error: "gateway 500" });
    // Still pending → the next run retries it.
    expect(await store.listUnaccrued(10)).toHaveLength(1);

    const second = await reconcileRoyaltyAccrualsCore({ store, accrueRoyalty: flaky, now: () => NOW, logger: silent });
    expect(second).toMatchObject({ scanned: 1, reconciled: 1, failed: 0 });
    expect(await store.listUnaccrued(10)).toEqual([]);
  });

  it("a failure on one run does not abort the batch (others still reconcile)", async () => {
    const store = new InMemoryRoyaltyAccrualStore();
    await store.recordUnaccrued(intent("run-bad"), NOW);
    await store.recordUnaccrued(intent("run-good", { orgId: "org-2" }), "2026-07-04T00:00:01.000Z");

    const res = await reconcileRoyaltyAccrualsCore({
      store,
      accrueRoyalty: async (i) => {
        if (i.runId === "run-bad") throw new Error("boom");
      },
      now: () => NOW,
      logger: silent,
    });

    expect(res).toMatchObject({ scanned: 2, reconciled: 1, failed: 1 });
    // run-good resolved; run-bad still pending for the next run.
    const pending = await store.listUnaccrued(10);
    expect(pending.map((p) => p.runId)).toEqual(["run-bad"]);
  });

  it("recordUnaccrued is idempotent on runId (no duplicate intents)", async () => {
    const store = new InMemoryRoyaltyAccrualStore();
    await store.recordUnaccrued(intent("run-c", { grossRoyaltyCents: 500 }), NOW);
    // A re-record (e.g. a re-run of the worker) must not duplicate or overwrite.
    await store.recordUnaccrued(intent("run-c", { grossRoyaltyCents: 999 }), NOW);
    const pending = await store.listUnaccrued(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].grossRoyaltyCents).toBe(500); // first write wins
  });
});
