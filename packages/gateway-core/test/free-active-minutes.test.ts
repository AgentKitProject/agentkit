/**
 * Auto v2 Slice 2 — free active-minute allowance (in-memory ledger adapter).
 *
 * The InMemoryCreditLedgerRepository is the reference implementation of the
 * `getFreeMinutesUsed` / `consumeFreeActiveMinutes` port methods; the commercial
 * Postgres + Dynamo adapters must match this behaviour. These tests pin the
 * free-minute math (within allowance, straddling the boundary, exhausted),
 * calendar-month reset (separate yearMonth keys), and idempotent re-settle
 * (per-runId, no double-deplete / double-charge).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryCreditLedgerRepository } from "../src/adapters/memory/credit-ledger.js";

const FREE = 60;

describe("InMemoryCreditLedger free active-minutes (Auto v2 Slice 2)", () => {
  let ledger: InMemoryCreditLedgerRepository;
  beforeEach(() => {
    ledger = new InMemoryCreditLedgerRepository();
  });

  it("reports 0 used for an untouched (user, month)", async () => {
    expect(await ledger.getFreeMinutesUsed("u1", "2026-06")).toBe(0);
  });

  it("within the allowance: nothing billable, usage incremented", async () => {
    const billable = await ledger.consumeFreeActiveMinutes("u1", "2026-06", 10, FREE, "run-1");
    expect(billable).toBe(0);
    expect(await ledger.getFreeMinutesUsed("u1", "2026-06")).toBe(10);
  });

  it("depletes the allowance across multiple runs in the month", async () => {
    await ledger.consumeFreeActiveMinutes("u1", "2026-06", 50, FREE, "run-1"); // used 50
    const billable = await ledger.consumeFreeActiveMinutes("u1", "2026-06", 5, FREE, "run-2"); // 55
    expect(billable).toBe(0);
    expect(await ledger.getFreeMinutesUsed("u1", "2026-06")).toBe(55);
  });

  it("straddling the boundary: only the minutes past the allowance are billable", async () => {
    await ledger.consumeFreeActiveMinutes("u1", "2026-06", 55, FREE, "run-1"); // used 55, free remaining 5
    // A 12-minute run: 5 free + 7 billable.
    const billable = await ledger.consumeFreeActiveMinutes("u1", "2026-06", 12, FREE, "run-2");
    expect(billable).toBe(7);
    // Usage increments by the FULL run minutes (allowance depletes by actual use).
    expect(await ledger.getFreeMinutesUsed("u1", "2026-06")).toBe(67);
  });

  it("allowance exhausted: the whole run is billable", async () => {
    await ledger.consumeFreeActiveMinutes("u1", "2026-06", 60, FREE, "run-1"); // exactly exhausts
    const billable = await ledger.consumeFreeActiveMinutes("u1", "2026-06", 8, FREE, "run-2");
    expect(billable).toBe(8);
  });

  it("calendar-month rollover resets the allowance", async () => {
    await ledger.consumeFreeActiveMinutes("u1", "2026-06", 60, FREE, "run-1"); // June exhausted
    const julyBillable = await ledger.consumeFreeActiveMinutes("u1", "2026-07", 10, FREE, "run-2");
    expect(julyBillable).toBe(0); // July starts fresh
    expect(await ledger.getFreeMinutesUsed("u1", "2026-06")).toBe(60);
    expect(await ledger.getFreeMinutesUsed("u1", "2026-07")).toBe(10);
  });

  it("is per-user (one user's usage does not deplete another's)", async () => {
    await ledger.consumeFreeActiveMinutes("u1", "2026-06", 60, FREE, "run-1");
    const billable = await ledger.consumeFreeActiveMinutes("u2", "2026-06", 10, FREE, "run-2");
    expect(billable).toBe(0);
  });

  it("idempotent re-settle: a repeated runId neither double-depletes nor re-charges", async () => {
    const first = await ledger.consumeFreeActiveMinutes("u1", "2026-06", 70, FREE, "run-1");
    expect(first).toBe(10); // 60 free + 10 billable
    expect(await ledger.getFreeMinutesUsed("u1", "2026-06")).toBe(70);

    // Re-settle the SAME run: same billable, usage unchanged.
    const second = await ledger.consumeFreeActiveMinutes("u1", "2026-06", 70, FREE, "run-1");
    expect(second).toBe(10);
    expect(await ledger.getFreeMinutesUsed("u1", "2026-06")).toBe(70);
  });

  it("freeAllowance 0 means every minute is billable (but still idempotent)", async () => {
    const first = await ledger.consumeFreeActiveMinutes("u1", "2026-06", 5, 0, "run-1");
    expect(first).toBe(5);
    const replay = await ledger.consumeFreeActiveMinutes("u1", "2026-06", 5, 0, "run-1");
    expect(replay).toBe(5);
    expect(await ledger.getFreeMinutesUsed("u1", "2026-06")).toBe(5);
  });
});
