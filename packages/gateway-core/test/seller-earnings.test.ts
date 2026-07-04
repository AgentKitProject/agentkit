/**
 * Seller-earnings ledger — premium (per-invocation) kit royalties.
 *
 * The InMemoryCreditLedgerRepository is the reference implementation of the
 * `accrueRoyalty` / `getPendingSellerEarnings` / `markSellerEarningsTransferred`
 * port methods (the commercial Postgres + Dynamo adapters must match). These
 * tests pin:
 *   - net calc: netCents = gross - floor(gross * commissionBps / 10000);
 *   - idempotency: the same runId accrues exactly once (source_ref keyed);
 *   - no-op at gross <= 0;
 *   - getPendingSellerEarnings returns only orgs with a positive balance;
 *   - markSellerEarningsTransferred is idempotent per transferRef.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryCreditLedgerRepository } from "../src/adapters/memory/credit-ledger.js";

const NOW = "2026-07-04T00:00:00.000Z";

describe("InMemoryCreditLedger seller-earnings (premium royalties)", () => {
  let ledger: InMemoryCreditLedgerRepository;
  beforeEach(() => {
    ledger = new InMemoryCreditLedgerRepository();
  });

  it("commissionBps 0 → the seller keeps 100% of the gross", async () => {
    await ledger.accrueRoyalty({
      orgId: "org-1",
      kitId: "kit-1",
      runId: "run-1",
      grossRoyaltyCents: 500,
      commissionBps: 0,
      now: NOW,
    });
    expect(await ledger.getPendingSellerEarnings()).toEqual([{ orgId: "org-1", pendingCents: 500 }]);
  });

  it("applies commissionBps: net = gross - floor(gross * bps / 10000)", async () => {
    // 500¢ @ 600bps (6%) → commission floor(500*600/10000)=floor(30)=30 → net 470.
    await ledger.accrueRoyalty({
      orgId: "org-1",
      kitId: "kit-1",
      runId: "run-1",
      grossRoyaltyCents: 500,
      commissionBps: 600,
      now: NOW,
    });
    expect(await ledger.getPendingSellerEarnings()).toEqual([{ orgId: "org-1", pendingCents: 470 }]);
  });

  it("floors the commission (partial-cent commission rounds DOWN, seller keeps the remainder)", async () => {
    // 333¢ @ 600bps → 333*600/10000 = 19.98 → floor 19 → net 314.
    await ledger.accrueRoyalty({
      orgId: "org-1",
      kitId: "kit-1",
      runId: "run-1",
      grossRoyaltyCents: 333,
      commissionBps: 600,
      now: NOW,
    });
    expect(await ledger.getPendingSellerEarnings()).toEqual([{ orgId: "org-1", pendingCents: 314 }]);
  });

  it("is idempotent per runId: accruing the same run twice accrues once", async () => {
    const input = {
      orgId: "org-1",
      kitId: "kit-1",
      runId: "run-1",
      grossRoyaltyCents: 500,
      commissionBps: 0,
      now: NOW,
    };
    await ledger.accrueRoyalty(input);
    await ledger.accrueRoyalty(input); // replay — no double-accrual
    expect(await ledger.getPendingSellerEarnings()).toEqual([{ orgId: "org-1", pendingCents: 500 }]);
  });

  it("sums distinct runs for the same org", async () => {
    await ledger.accrueRoyalty({ orgId: "org-1", kitId: "k", runId: "run-1", grossRoyaltyCents: 500, commissionBps: 0, now: NOW });
    await ledger.accrueRoyalty({ orgId: "org-1", kitId: "k", runId: "run-2", grossRoyaltyCents: 300, commissionBps: 0, now: NOW });
    expect(await ledger.getPendingSellerEarnings()).toEqual([{ orgId: "org-1", pendingCents: 800 }]);
  });

  it("no-op at gross 0 (and negative): nothing accrues", async () => {
    await ledger.accrueRoyalty({ orgId: "org-1", kitId: "k", runId: "run-1", grossRoyaltyCents: 0, commissionBps: 0, now: NOW });
    await ledger.accrueRoyalty({ orgId: "org-1", kitId: "k", runId: "run-2", grossRoyaltyCents: -100, commissionBps: 0, now: NOW });
    expect(await ledger.getPendingSellerEarnings()).toEqual([]);
  });

  it("getPendingSellerEarnings lists only orgs with a positive balance, sorted by org", async () => {
    await ledger.accrueRoyalty({ orgId: "org-b", kitId: "k", runId: "r1", grossRoyaltyCents: 200, commissionBps: 0, now: NOW });
    await ledger.accrueRoyalty({ orgId: "org-a", kitId: "k", runId: "r2", grossRoyaltyCents: 100, commissionBps: 0, now: NOW });
    // org-a fully paid out → excluded from pending.
    await ledger.markSellerEarningsTransferred("org-a", 100, "xfer-a", NOW);
    expect(await ledger.getPendingSellerEarnings()).toEqual([{ orgId: "org-b", pendingCents: 200 }]);
  });

  it("markSellerEarningsTransferred reduces the pending balance", async () => {
    await ledger.accrueRoyalty({ orgId: "org-1", kitId: "k", runId: "r1", grossRoyaltyCents: 500, commissionBps: 0, now: NOW });
    await ledger.markSellerEarningsTransferred("org-1", 200, "xfer-1", NOW);
    expect(await ledger.getPendingSellerEarnings()).toEqual([{ orgId: "org-1", pendingCents: 300 }]);
  });

  it("markSellerEarningsTransferred is idempotent per transferRef", async () => {
    await ledger.accrueRoyalty({ orgId: "org-1", kitId: "k", runId: "r1", grossRoyaltyCents: 500, commissionBps: 0, now: NOW });
    await ledger.markSellerEarningsTransferred("org-1", 200, "xfer-1", NOW);
    await ledger.markSellerEarningsTransferred("org-1", 200, "xfer-1", NOW); // replay
    expect(await ledger.getPendingSellerEarnings()).toEqual([{ orgId: "org-1", pendingCents: 300 }]);
  });

  it("a fully-transferred org drops out of pending", async () => {
    await ledger.accrueRoyalty({ orgId: "org-1", kitId: "k", runId: "r1", grossRoyaltyCents: 500, commissionBps: 0, now: NOW });
    await ledger.markSellerEarningsTransferred("org-1", 500, "xfer-1", NOW);
    expect(await ledger.getPendingSellerEarnings()).toEqual([]);
  });
});
