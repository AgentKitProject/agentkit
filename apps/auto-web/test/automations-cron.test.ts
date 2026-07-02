/**
 * Automations phrase builder + next-fire preview (lib/automations/cron.ts).
 * Pins the phrase → cron table, the constrained-cron parser, the general
 * 5-field syntax validator (Advanced mode), and nextFires() correctness —
 * including across DST boundaries (America/New_York, 2026: spring-forward
 * Mar 8, fall-back Nov 1).
 */
import { describe, expect, it } from "vitest";
import {
  cronToPhrase,
  describePhrase,
  nextFires,
  parseConstrainedCron,
  phraseToCron,
  validateCronSyntax,
  zonedTimeToUtc,
  type SchedulePhrase
} from "@/lib/automations/cron";

describe("phraseToCron — the phrase → cron table", () => {
  const table: [SchedulePhrase, string][] = [
    [{ frequency: "hourly" }, "0 * * * *"],
    [{ frequency: "hourly", minute: 15 }, "15 * * * *"],
    [{ frequency: "daily", time: "09:30" }, "30 9 * * *"],
    [{ frequency: "daily", time: "00:00" }, "0 0 * * *"],
    [{ frequency: "daily", time: "23:59" }, "59 23 * * *"],
    [{ frequency: "weekdays", time: "08:00" }, "0 8 * * 1-5"],
    [{ frequency: "weekly", time: "18:00", dayOfWeek: 0 }, "0 18 * * 0"],
    [{ frequency: "weekly", time: "08:15", dayOfWeek: 5 }, "15 8 * * 5"],
    [{ frequency: "monthly", time: "06:00", dayOfMonth: 1 }, "0 6 1 * *"],
    [{ frequency: "monthly", time: "12:30", dayOfMonth: 31 }, "30 12 31 * *"]
  ];
  it.each(table)("%j → %s", (phrase, cron) => {
    expect(phraseToCron(phrase)).toBe(cron);
  });

  it("clamps out-of-range values instead of emitting invalid cron", () => {
    expect(phraseToCron({ frequency: "daily", time: "99:99" })).toBe("59 23 * * *");
    expect(phraseToCron({ frequency: "monthly", time: "09:00", dayOfMonth: 99 })).toBe("0 9 31 * *");
    expect(phraseToCron({ frequency: "hourly", minute: 99 })).toBe("59 * * * *");
  });

  it("defaults: 09:00, Monday, day 1, minute 0", () => {
    expect(phraseToCron({ frequency: "daily" })).toBe("0 9 * * *");
    expect(phraseToCron({ frequency: "weekly" })).toBe("0 9 * * 1");
    expect(phraseToCron({ frequency: "monthly" })).toBe("0 9 1 * *");
  });
});

describe("cronToPhrase — inverse for edit-mode prefill", () => {
  it("round-trips every builder shape", () => {
    const phrases: SchedulePhrase[] = [
      { frequency: "hourly", minute: 5 },
      { frequency: "daily", time: "07:45" },
      { frequency: "weekdays", time: "09:00" },
      { frequency: "weekly", time: "18:30", dayOfWeek: 3 },
      { frequency: "monthly", time: "01:00", dayOfMonth: 15 }
    ];
    for (const p of phrases) {
      const back = cronToPhrase(phraseToCron(p));
      expect(back?.frequency).toBe(p.frequency);
      expect(phraseToCron(back as SchedulePhrase)).toBe(phraseToCron(p));
    }
  });

  it("returns null for non-builder crons (wizard falls back to Advanced)", () => {
    expect(cronToPhrase("*/5 * * * *")).toBeNull();
    expect(cronToPhrase("0 9 * * 1,3")).toBeNull();
    expect(cronToPhrase("0 9 1 6 *")).toBeNull();
  });
});

describe("parseConstrainedCron", () => {
  it("accepts exactly the builder shapes", () => {
    expect(parseConstrainedCron("0 * * * *")).toEqual({ minute: 0, hour: null, dayOfMonth: null, dow: "any" });
    expect(parseConstrainedCron("30 9 * * *")).toEqual({ minute: 30, hour: 9, dayOfMonth: null, dow: "any" });
    expect(parseConstrainedCron("0 8 * * 1-5")).toEqual({ minute: 0, hour: 8, dayOfMonth: null, dow: "weekdays" });
    expect(parseConstrainedCron("0 18 * * 0")).toEqual({ minute: 0, hour: 18, dayOfMonth: null, dow: 0 });
    expect(parseConstrainedCron("30 12 15 * *")).toEqual({ minute: 30, hour: 12, dayOfMonth: 15, dow: "any" });
  });

  it("rejects everything else", () => {
    expect(parseConstrainedCron("*/5 * * * *")).toBeNull(); // step minute
    expect(parseConstrainedCron("0 9 * 6 *")).toBeNull(); // month constrained
    expect(parseConstrainedCron("0 9 1 * 1")).toBeNull(); // dom AND dow
    expect(parseConstrainedCron("0 9 * *")).toBeNull(); // 4 fields
    expect(parseConstrainedCron("60 9 * * *")).toBeNull(); // minute out of range
    expect(parseConstrainedCron("0 24 * * *")).toBeNull(); // hour out of range
    expect(parseConstrainedCron("0 9 * * 7")).toBeNull(); // dow 7 not emitted by builder
  });
});

describe("validateCronSyntax — Advanced-mode validation", () => {
  it("accepts standard 5-field expressions", () => {
    expect(validateCronSyntax("0 9 * * *")).toBeNull();
    expect(validateCronSyntax("*/15 0-6 1,15 * 1-5")).toBeNull();
    expect(validateCronSyntax("5 4 * * 7")).toBeNull(); // 7 = Sunday alias
  });

  it("rejects malformed expressions with a plain-language message", () => {
    expect(validateCronSyntax("0 9 * *")).toMatch(/5 fields/);
    expect(validateCronSyntax("61 * * * *")).toMatch(/minute/);
    expect(validateCronSyntax("0 25 * * *")).toMatch(/hour/);
    expect(validateCronSyntax("0 9 0 * *")).toMatch(/day-of-month/);
    expect(validateCronSyntax("0 9 * 13 *")).toMatch(/month/);
    expect(validateCronSyntax("0 9 * * 8")).toMatch(/day-of-week/);
    expect(validateCronSyntax("0 9 * * mon")).toMatch(/day-of-week/);
    expect(validateCronSyntax("9-5 * * * *")).toMatch(/minute/); // inverted range
    expect(validateCronSyntax("0,,5 * * * *")).toMatch(/minute/); // empty list atom
  });
});

describe("zonedTimeToUtc", () => {
  it("converts wall clock to the right instant (EST vs EDT)", () => {
    // Jan 15 2026 09:00 EST = 14:00 UTC.
    expect(zonedTimeToUtc(2026, 1, 15, 9, 0, "America/New_York")).toBe(Date.UTC(2026, 0, 15, 14, 0));
    // Jul 15 2026 09:00 EDT = 13:00 UTC.
    expect(zonedTimeToUtc(2026, 7, 15, 9, 0, "America/New_York")).toBe(Date.UTC(2026, 6, 15, 13, 0));
    // UTC is the identity.
    expect(zonedTimeToUtc(2026, 3, 1, 12, 30, "UTC")).toBe(Date.UTC(2026, 2, 1, 12, 30));
  });

  it("returns null for a nonexistent wall time (spring-forward gap)", () => {
    // 2026-03-08 02:30 does not exist in America/New_York (02:00 → 03:00).
    expect(zonedTimeToUtc(2026, 3, 8, 2, 30, "America/New_York")).toBeNull();
  });
});

describe("nextFires", () => {
  it("daily in UTC: strictly-after semantics and 24h spacing", () => {
    const from = Date.UTC(2026, 5, 10, 8, 59); // 2026-06-10 08:59 UTC
    const fires = nextFires("0 9 * * *", "UTC", from, 3);
    expect(fires.map((d) => d.toISOString())).toEqual([
      "2026-06-10T09:00:00.000Z",
      "2026-06-11T09:00:00.000Z",
      "2026-06-12T09:00:00.000Z"
    ]);
    // Exactly at the fire instant → the NEXT day (strictly after).
    const atNine = nextFires("0 9 * * *", "UTC", Date.UTC(2026, 5, 10, 9, 0), 1);
    expect(atNine[0].toISOString()).toBe("2026-06-11T09:00:00.000Z");
  });

  it("hourly: next fires at the top of coming hours", () => {
    const from = Date.UTC(2026, 5, 10, 8, 30);
    const fires = nextFires("0 * * * *", "UTC", from, 3);
    expect(fires.map((d) => d.toISOString())).toEqual([
      "2026-06-10T09:00:00.000Z",
      "2026-06-10T10:00:00.000Z",
      "2026-06-10T11:00:00.000Z"
    ]);
  });

  it("weekdays: skips Saturday and Sunday", () => {
    // Fri 2026-06-12 10:00 UTC → next weekday 09:00 fires are Mon, Tue, Wed.
    const from = Date.UTC(2026, 5, 12, 10, 0);
    const fires = nextFires("0 9 * * 1-5", "UTC", from, 3);
    expect(fires.map((d) => d.toISOString())).toEqual([
      "2026-06-15T09:00:00.000Z",
      "2026-06-16T09:00:00.000Z",
      "2026-06-17T09:00:00.000Z"
    ]);
  });

  it("weekly + monthly land on the right calendar days", () => {
    const from = Date.UTC(2026, 5, 10); // Wed 2026-06-10
    const weekly = nextFires("0 18 * * 0", "UTC", from, 2); // Sundays
    expect(weekly.map((d) => d.toISOString())).toEqual([
      "2026-06-14T18:00:00.000Z",
      "2026-06-21T18:00:00.000Z"
    ]);
    const monthly = nextFires("30 6 15 * *", "UTC", from, 2);
    expect(monthly.map((d) => d.toISOString())).toEqual([
      "2026-06-15T06:30:00.000Z",
      "2026-07-15T06:30:00.000Z"
    ]);
  });

  it("monthly on day 31 only fires in 31-day months", () => {
    const from = Date.UTC(2026, 0, 1);
    const fires = nextFires("0 9 31 * *", "UTC", from, 3);
    expect(fires.map((d) => d.toISOString())).toEqual([
      "2026-01-31T09:00:00.000Z",
      "2026-03-31T09:00:00.000Z", // February skipped
      "2026-05-31T09:00:00.000Z" // April skipped
    ]);
  });

  it("DST spring-forward: daily 09:00 New York keeps wall time (UTC gap shrinks to 23h)", () => {
    // US DST 2026 begins Sun Mar 8. Sat Mar 7 09:00 EST = 14:00 UTC;
    // Sun Mar 8 09:00 EDT = 13:00 UTC → 23h apart in UTC, same wall time.
    const from = Date.UTC(2026, 2, 7, 0, 0);
    const fires = nextFires("0 9 * * *", "America/New_York", from, 2);
    expect(fires.map((d) => d.toISOString())).toEqual([
      "2026-03-07T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z"
    ]);
  });

  it("DST spring-forward: a 02:30 daily fire is skipped on the gap day", () => {
    // From Sat Mar 7 12:00 UTC: Mar 8 02:30 does not exist in America/New_York
    // (clocks jump 02:00 → 03:00), so the next fires are Mar 9 and Mar 10
    // 02:30 EDT (= 06:30 UTC).
    const from = Date.UTC(2026, 2, 7, 12, 0);
    const fires = nextFires("30 2 * * *", "America/New_York", from, 2);
    expect(fires.map((d) => d.toISOString())).toEqual([
      "2026-03-09T06:30:00.000Z",
      "2026-03-10T06:30:00.000Z"
    ]);
  });

  it("DST fall-back: daily 09:00 New York keeps wall time (UTC gap grows to 25h)", () => {
    // US DST 2026 ends Sun Nov 1. Sat Oct 31 09:00 EDT = 13:00 UTC;
    // Sun Nov 1 09:00 EST = 14:00 UTC → 25h apart in UTC.
    const from = Date.UTC(2026, 9, 31, 0, 0);
    const fires = nextFires("0 9 * * *", "America/New_York", from, 2);
    expect(fires.map((d) => d.toISOString())).toEqual([
      "2026-10-31T13:00:00.000Z",
      "2026-11-01T14:00:00.000Z"
    ]);
  });

  it("returns [] for non-builder crons and bad timezones (preview hides)", () => {
    expect(nextFires("*/5 * * * *", "UTC", Date.UTC(2026, 0, 1), 3)).toEqual([]);
    expect(nextFires("0 9 * * *", "Not/AZone", Date.UTC(2026, 0, 1), 3)).toEqual([]);
  });
});

describe("describePhrase", () => {
  it("says it in plain language", () => {
    expect(describePhrase({ frequency: "hourly", minute: 5 })).toBe("Every hour at :05");
    expect(describePhrase({ frequency: "daily", time: "09:30" })).toBe("Every day at 09:30");
    expect(describePhrase({ frequency: "weekdays", time: "08:00" })).toBe("Weekdays (Mon–Fri) at 08:00");
    expect(describePhrase({ frequency: "weekly", time: "18:00", dayOfWeek: 0 })).toBe("Every Sunday at 18:00");
    expect(describePhrase({ frequency: "monthly", time: "06:00", dayOfMonth: 15 })).toBe("Monthly on day 15 at 06:00");
  });
});
