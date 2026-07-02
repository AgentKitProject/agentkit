// Automations "When" phrase builder — friendly phrase → 5-field cron, plus a
// small PURE client-side next-fire previewer for ONLY the constrained cron
// shapes the builder emits, and a general 5-field syntax validator for the
// "Advanced: edit cron" escape hatch.
//
// The server (schedule trigger evaluator) remains the source of truth for
// actual fire times; nextFires() exists purely so the wizard can show a
// trustworthy "Next runs:" preview. Timezone math uses Intl only (no deps).
//
// DST semantics of the preview (documented + unit-tested):
//   • a wall-clock time that DOES NOT EXIST on a given day (spring-forward
//     gap) is skipped for that day;
//   • an AMBIGUOUS wall-clock time (fall-back overlap) resolves to a single
//     instant (the one the offset iteration converges to);
//   • hourly previews list one fire per wall-clock hour label per day.

export type PhraseFrequency = "hourly" | "daily" | "weekdays" | "weekly" | "monthly";

/** 0 = Sunday … 6 = Saturday (standard cron day-of-week). */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type SchedulePhrase = {
  frequency: PhraseFrequency;
  /** "HH:MM" 24-hour clock — daily / weekdays / weekly / monthly. */
  time?: string;
  /** Minute past each hour (0–59) — hourly only. Defaults to 0. */
  minute?: number;
  /** Day of week (0–6) — weekly only. Defaults to Monday (1). */
  dayOfWeek?: DayOfWeek;
  /** Day of month (1–31) — monthly only. Defaults to 1. */
  dayOfMonth?: number;
};

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Parse "HH:MM" into [hour, minute], clamped. Defaults to 09:00. */
function parseTime(time: string | undefined): [number, number] {
  const [h, m] = (time ?? "09:00").split(":");
  return [clamp(Number.parseInt(h ?? "", 10), 0, 23, 9), clamp(Number.parseInt(m ?? "", 10), 0, 59, 0)];
}

/**
 * The phrase → cron table (minute hour day-of-month month day-of-week):
 *   hourly            → `M * * * *`
 *   daily at HH:MM    → `M H * * *`
 *   weekdays at HH:MM → `M H * * 1-5`
 *   weekly on D       → `M H * * D`
 *   monthly on DOM    → `M H DOM * *`
 */
export function phraseToCron(p: SchedulePhrase): string {
  switch (p.frequency) {
    case "hourly":
      return `${clamp(p.minute ?? 0, 0, 59, 0)} * * * *`;
    case "daily": {
      const [h, m] = parseTime(p.time);
      return `${m} ${h} * * *`;
    }
    case "weekdays": {
      const [h, m] = parseTime(p.time);
      return `${m} ${h} * * 1-5`;
    }
    case "weekly": {
      const [h, m] = parseTime(p.time);
      return `${m} ${h} * * ${clamp(p.dayOfWeek ?? 1, 0, 6, 1)}`;
    }
    case "monthly": {
      const [h, m] = parseTime(p.time);
      return `${m} ${h} ${clamp(p.dayOfMonth ?? 1, 1, 31, 1)} * *`;
    }
  }
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Human sentence for the review summary, e.g. "Every Monday at 09:00". */
export function describePhrase(p: SchedulePhrase): string {
  const [h, m] = parseTime(p.time);
  const hhmm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  switch (p.frequency) {
    case "hourly":
      return `Every hour at :${String(clamp(p.minute ?? 0, 0, 59, 0)).padStart(2, "0")}`;
    case "daily":
      return `Every day at ${hhmm}`;
    case "weekdays":
      return `Weekdays (Mon–Fri) at ${hhmm}`;
    case "weekly":
      return `Every ${DAY_NAMES[clamp(p.dayOfWeek ?? 1, 0, 6, 1)]} at ${hhmm}`;
    case "monthly":
      return `Monthly on day ${clamp(p.dayOfMonth ?? 1, 1, 31, 1)} at ${hhmm}`;
  }
}

// ---------------------------------------------------------------------------
// Constrained-cron parsing (ONLY the shapes phraseToCron emits)
// ---------------------------------------------------------------------------

export type ConstrainedCron = {
  minute: number;
  /** null = every hour (hourly phrase). */
  hour: number | null;
  /** null = any day of month. */
  dayOfMonth: number | null;
  /** Day-of-week constraint: any day, Mon–Fri, or one fixed day. */
  dow: "any" | "weekdays" | DayOfWeek;
};

const NUM_RE = /^\d{1,2}$/;

/**
 * Parse ONLY the constrained cron shapes the phrase builder emits (fixed
 * minute; fixed-or-* hour; fixed-or-* dom; month *; dow fixed, 1-5, or *; at
 * most one of dom/dow constrained). Returns null for anything else — callers
 * then hide the "Next runs" preview rather than guessing.
 */
export function parseConstrainedCron(cron: string): ConstrainedCron | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minS, hourS, domS, monS, dowS] = fields;
  if (monS !== "*") return null;
  if (!NUM_RE.test(minS)) return null;
  const minute = Number(minS);
  if (minute > 59) return null;

  let hour: number | null = null;
  if (hourS !== "*") {
    if (!NUM_RE.test(hourS)) return null;
    hour = Number(hourS);
    if (hour > 23) return null;
  }

  let dayOfMonth: number | null = null;
  if (domS !== "*") {
    if (!NUM_RE.test(domS)) return null;
    dayOfMonth = Number(domS);
    if (dayOfMonth < 1 || dayOfMonth > 31) return null;
  }

  let dow: ConstrainedCron["dow"] = "any";
  if (dowS === "1-5") {
    dow = "weekdays";
  } else if (dowS !== "*") {
    if (!NUM_RE.test(dowS)) return null;
    const d = Number(dowS);
    if (d > 6) return null;
    dow = d as DayOfWeek;
  }

  // The builder never constrains both dom and dow simultaneously.
  if (dayOfMonth !== null && dow !== "any") return null;
  return { minute, hour, dayOfMonth, dow };
}

/**
 * Inverse of phraseToCron for the builder shapes — used to prefill the phrase
 * UI when editing an existing schedule trigger. Non-builder crons return null
 * (the wizard falls back to Advanced mode with the raw expression).
 */
export function cronToPhrase(cron: string): SchedulePhrase | null {
  const c = parseConstrainedCron(cron);
  if (!c) return null;
  if (c.hour === null) {
    if (c.dayOfMonth !== null || c.dow !== "any") return null;
    return { frequency: "hourly", minute: c.minute };
  }
  const time = `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
  if (c.dayOfMonth !== null) return { frequency: "monthly", time, dayOfMonth: c.dayOfMonth };
  if (c.dow === "weekdays") return { frequency: "weekdays", time };
  if (typeof c.dow === "number") return { frequency: "weekly", time, dayOfWeek: c.dow };
  return { frequency: "daily", time };
}

// ---------------------------------------------------------------------------
// Timezone helpers (Intl-only; no deps)
// ---------------------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

/** True when `tz` is an IANA zone Intl can resolve. */
export function isValidTimezone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

type Wall = { y: number; mo: number; d: number; hh: number; mm: number };

/** The wall-clock fields of a UTC instant in `timeZone`. */
function wallParts(tsMs: number, timeZone: string): Wall {
  const parts = formatter(timeZone).formatToParts(tsMs);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { y: get("year"), mo: get("month"), d: get("day"), hh: get("hour") % 24, mm: get("minute") };
}

/** Zone offset (ms east of UTC) at instant `tsMs`, minute precision. */
function tzOffsetMs(tsMs: number, timeZone: string): number {
  const w = wallParts(tsMs, timeZone);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.hh, w.mm);
  return asUtc - Math.floor(tsMs / 60000) * 60000;
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC instant (ms). Returns null
 * when the wall time does not exist (DST spring-forward gap). Ambiguous
 * (fall-back) times resolve to a single instant.
 */
export function zonedTimeToUtc(
  y: number,
  mo: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string
): number | null {
  const wallAsUtc = Date.UTC(y, mo - 1, d, hh, mm);
  // Two-pass offset convergence: guess with the offset at the naive instant,
  // then refine with the offset at the guess.
  let ts = wallAsUtc - tzOffsetMs(wallAsUtc, timeZone);
  ts = wallAsUtc - tzOffsetMs(ts, timeZone);
  const w = wallParts(ts, timeZone);
  if (w.y === y && w.mo === mo && w.d === d && w.hh === hh && w.mm === mm) return ts;
  return null; // nonexistent wall time (DST gap)
}

// ---------------------------------------------------------------------------
// Next-fire preview
// ---------------------------------------------------------------------------

/** Search horizon in days (covers any monthly cadence incl. day 31). */
const MAX_SEARCH_DAYS = 400;

/**
 * The next `count` fire instants of a BUILDER-CONSTRAINED cron in `timezone`,
 * strictly after `from`. Returns [] when the cron isn't a builder shape or the
 * timezone is invalid (callers hide the preview then).
 */
export function nextFires(
  cron: string,
  timezone: string,
  from: Date | number = Date.now(),
  count = 3
): Date[] {
  const c = parseConstrainedCron(cron);
  if (!c || count <= 0 || !isValidTimezone(timezone)) return [];
  const fromMs = typeof from === "number" ? from : from.getTime();
  const out: Date[] = [];

  // Walk calendar days in the target zone starting from `from`'s wall date.
  const start = wallParts(fromMs, timezone);
  const startDayUtc = Date.UTC(start.y, start.mo - 1, start.d);
  for (let dayIdx = 0; dayIdx < MAX_SEARCH_DAYS && out.length < count; dayIdx++) {
    const day = new Date(startDayUtc + dayIdx * 86400000);
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const dow = day.getUTCDay(); // day-of-week of the calendar DATE (pure date math)

    if (c.dayOfMonth !== null && d !== c.dayOfMonth) continue;
    if (c.dow === "weekdays" && (dow === 0 || dow === 6)) continue;
    if (typeof c.dow === "number" && dow !== c.dow) continue;

    const hours = c.hour === null ? Array.from({ length: 24 }, (_, i) => i) : [c.hour];
    for (const hh of hours) {
      const ts = zonedTimeToUtc(y, mo, d, hh, c.minute, timezone);
      if (ts === null) continue; // DST gap — this wall time doesn't exist today
      if (ts <= fromMs) continue;
      out.push(new Date(ts));
      if (out.length >= count) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// General 5-field cron syntax validation (Advanced mode)
// ---------------------------------------------------------------------------

type FieldSpec = { name: string; min: number; max: number };

const CRON_FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 } // 7 = Sunday alias
];

function validAtom(atom: string, spec: FieldSpec): boolean {
  // atom = "*" | N | A-B, optionally with a /step suffix.
  const [base, step, extra] = atom.split("/");
  if (extra !== undefined) return false;
  if (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1)) return false;
  if (base === "*") return true;
  const range = base.split("-");
  if (range.length > 2) return false;
  for (const part of range) {
    if (!/^\d+$/.test(part)) return false;
    const n = Number(part);
    if (n < spec.min || n > spec.max) return false;
  }
  if (range.length === 2 && Number(range[0]) > Number(range[1])) return false;
  return true;
}

/**
 * Validate a general 5-field cron expression (numbers, `*`, ranges, steps,
 * comma lists — no names/macros). Returns null when valid, else a
 * plain-language error message for the Advanced field.
 */
export function validateCronSyntax(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return "A cron expression has 5 fields: minute hour day-of-month month day-of-week.";
  }
  for (let i = 0; i < 5; i++) {
    const spec = CRON_FIELDS[i];
    const atoms = fields[i].split(",");
    if (atoms.some((a) => a.length === 0 || !validAtom(a, spec))) {
      return `Invalid ${spec.name} field "${fields[i]}" (allowed: *, ${spec.min}-${spec.max}, ranges, steps, lists).`;
    }
  }
  return null;
}
