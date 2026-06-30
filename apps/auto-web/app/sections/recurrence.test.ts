// Recurrence → cron mapping (recurrence.ts). Pins the cron field order
// (minute hour day-of-month month day-of-week) for each friendly cadence.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recurrenceToCron } from "./recurrence.ts";

describe("recurrenceToCron", () => {
  it("hourly fires at the top of every hour", () => {
    assert.equal(recurrenceToCron("hourly"), "0 * * * *");
  });

  it("daily fires every day at HH:MM", () => {
    assert.equal(recurrenceToCron("daily", { time: "09:30" }), "30 9 * * *");
    assert.equal(recurrenceToCron("daily", { time: "00:00" }), "0 0 * * *");
    assert.equal(recurrenceToCron("daily", { time: "23:59" }), "59 23 * * *");
  });

  it("weekly fires on the given day-of-week at HH:MM", () => {
    // Monday (1) at 08:15.
    assert.equal(recurrenceToCron("weekly", { time: "08:15", dayOfWeek: 1 }), "15 8 * * 1");
    // Sunday (0) at 18:00.
    assert.equal(recurrenceToCron("weekly", { time: "18:00", dayOfWeek: 0 }), "0 18 * * 0");
  });

  it("monthly fires on the given day-of-month at HH:MM", () => {
    assert.equal(recurrenceToCron("monthly", { time: "06:00", dayOfMonth: 1 }), "0 6 1 * *");
    assert.equal(recurrenceToCron("monthly", { time: "12:30", dayOfMonth: 15 }), "30 12 15 * *");
  });

  it("defaults to 09:00 / Monday / day 1 when options are omitted", () => {
    assert.equal(recurrenceToCron("daily"), "0 9 * * *");
    assert.equal(recurrenceToCron("weekly"), "0 9 * * 1");
    assert.equal(recurrenceToCron("monthly"), "0 9 1 * *");
  });

  it("clamps out-of-range time / day values to valid cron ranges", () => {
    assert.equal(recurrenceToCron("daily", { time: "99:99" }), "59 23 * * *");
    assert.equal(recurrenceToCron("monthly", { time: "09:00", dayOfMonth: 99 }), "0 9 31 * *");
  });

  it("throws for 'advanced' (no canonical cron — raw string is sent instead)", () => {
    assert.throws(() => recurrenceToCron("advanced"), /advanced/);
  });
});
