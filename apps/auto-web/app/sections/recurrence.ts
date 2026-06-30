// Friendly recurrence → 5-field cron (minute hour day-of-month month day-of-week).
// The Schedules pane uses this to let users pick a common cadence (Hourly / Daily /
// Weekly / Monthly) without writing cron by hand; "Advanced (cron)" bypasses this
// and sends a raw expression. Pure + unit-tested.

export type RecurrenceKind = "hourly" | "daily" | "weekly" | "monthly" | "advanced";

// 0 = Sunday … 6 = Saturday (standard cron day-of-week).
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type RecurrenceOpts = {
  /** "HH:MM" 24-hour clock; used by daily / weekly / monthly. */
  time?: string;
  /** Day of week (0–6); used by weekly. */
  dayOfWeek?: DayOfWeek;
  /** Day of month (1–31); used by monthly. */
  dayOfMonth?: number;
};

/** Parse "HH:MM" into [hour, minute], clamped to valid ranges. Defaults to 09:00. */
function parseTime(time: string | undefined): [number, number] {
  const [h, m] = (time ?? "09:00").split(":");
  const hour = clamp(Number.parseInt(h ?? "", 10), 0, 23, 9);
  const minute = clamp(Number.parseInt(m ?? "", 10), 0, 59, 0);
  return [hour, minute];
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Build a 5-field cron expression from a friendly recurrence:
 *   hourly  → `0 * * * *`           (top of every hour)
 *   daily   → `M H * * *`           (every day at HH:MM)
 *   weekly  → `M H * * D`           (each <dow> at HH:MM)
 *   monthly → `M H D * *`           (the <dom> at HH:MM)
 * `advanced` has no canonical cron (the UI sends a raw string instead); calling
 * with it throws so the caller doesn't accidentally use a fabricated value.
 */
export function recurrenceToCron(kind: RecurrenceKind, opts: RecurrenceOpts = {}): string {
  switch (kind) {
    case "hourly":
      return "0 * * * *";
    case "daily": {
      const [h, m] = parseTime(opts.time);
      return `${m} ${h} * * *`;
    }
    case "weekly": {
      const [h, m] = parseTime(opts.time);
      const dow = clamp(opts.dayOfWeek ?? 1, 0, 6, 1);
      return `${m} ${h} * * ${dow}`;
    }
    case "monthly": {
      const [h, m] = parseTime(opts.time);
      const dom = clamp(opts.dayOfMonth ?? 1, 1, 31, 1);
      return `${m} ${h} ${dom} * *`;
    }
    case "advanced":
      throw new Error("recurrenceToCron: 'advanced' has no canonical cron; send the raw expression.");
  }
}
