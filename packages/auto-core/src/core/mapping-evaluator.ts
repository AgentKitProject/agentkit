/**
 * Mapping evaluator (event-driven expansion) — S1 ENFORCEMENT LIVES HERE.
 *
 * S1: events are DATA, never instructions. `TriggerMapping.promptTemplate` is
 * the ONLY instruction source for a trigger-fired run. Event payload values are
 * interpolated into `{{path.to.field}}` placeholders as VALUES (each expansion
 * capped, the final prompt capped) and the raw payload may be attached as an
 * inline FILE — payload content is NEVER concatenated into the prompt as free
 * text and NEVER treated as a template (interpolation is single-pass: a payload
 * value containing `{{x}}` is emitted literally, not re-expanded).
 *
 * PATH SAFETY: paths are declarative dot/bracket data addressing only — NO
 * eval, NO expressions, NO prototype-chain access. `__proto__`, `constructor`
 * and `prototype` segments are rejected outright; property reads go through an
 * own-property check (`Object.prototype.hasOwnProperty`), so inherited members
 * (`toString`, `constructor`, ...) are unreachable.
 *
 * REGEX SAFETY (`matches` op): patterns are compiled with a linear-time safety
 * HEURISTIC, not a full RE2 guarantee. We reject up-front:
 *   - patterns longer than MATCH_PATTERN_MAX_LENGTH (200 chars);
 *   - backreferences (`\1`..`\9`, `\k<name>`) — never linear-time;
 *   - quantified groups — an unescaped `)` immediately followed by `+`, `*` or
 *     `{` (the `(…)+` / `(a+)*` / `(a|b){2,}` nested-quantifier shapes behind
 *     catastrophic backtracking).
 * On top of that the evaluated INPUT is hard-capped to
 * MAPPING_FIELD_INTERPOLATION_MAX_CHARS, so even a pathological-but-unbanned
 * pattern has a small, bounded subject. This is a heuristic: it can reject some
 * safe patterns (e.g. `(ab)+`); that trade-off is intentional.
 */

import type { AutoRunInput, TriggerFilter, TriggerMapping } from "./types.js";
import {
  EVENT_PAYLOAD_MAX_BYTES,
  MAPPING_FIELD_INTERPOLATION_MAX_CHARS,
  MAPPING_TOTAL_PROMPT_MAX_CHARS,
} from "./types.js";

// ---------------------------------------------------------------------------
// Safe path walking
// ---------------------------------------------------------------------------

/** Segments that would walk the prototype chain / pollute — always rejected. */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Maximum accepted path length (matches the contracts filter path cap). */
const PATH_MAX_LENGTH = 200;

/** The result of resolving a path against a payload. */
export interface ResolvedPath {
  /** True when every segment resolved to an OWN property / in-range index. */
  found: boolean;
  /** The resolved value (undefined when not found). */
  value: unknown;
}

const NOT_FOUND: ResolvedPath = { found: false, value: undefined };

/**
 * Tokenizes a dot/bracket path (`a.b[0]["c-d"]`) into segments. Bare segments
 * are identifier-like; anything else (dashes, spaces, dots-in-keys) must use a
 * quoted bracket. Returns undefined for malformed paths.
 */
function parsePathSegments(path: string): string[] | undefined {
  if (path.length === 0 || path.length > PATH_MAX_LENGTH) return undefined;
  // Sticky alternation: `^` only matches at the very start, so later bare
  // segments require a leading dot; brackets carry a numeric index or a
  // quoted key.
  const re = /(?:^|\.)([A-Za-z_$][\w$]*)|\[(\d+)\]|\[(?:"([^"]*)"|'([^']*)')\]/y;
  const segments: string[] = [];
  let idx = 0;
  while (idx < path.length) {
    re.lastIndex = idx;
    const m = re.exec(path);
    if (!m || m.index !== idx) return undefined;
    const seg = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (seg === undefined || seg.length === 0) return undefined;
    segments.push(seg);
    idx = re.lastIndex;
  }
  return segments.length > 0 ? segments : undefined;
}

/**
 * Safely resolves a dot/bracket path against a payload. NO eval, NO prototype
 * chain: forbidden segments (`__proto__`/`constructor`/`prototype`) and
 * inherited properties resolve as NOT FOUND; primitives have no addressable
 * properties (so `str.length` etc. is not reachable either).
 */
export function resolvePath(payload: unknown, path: string): ResolvedPath {
  const segments = parsePathSegments(path);
  if (!segments) return NOT_FOUND;
  for (const seg of segments) {
    if (FORBIDDEN_SEGMENTS.has(seg)) return NOT_FOUND;
  }
  let current: unknown = payload;
  for (const seg of segments) {
    if (current === null || current === undefined) return NOT_FOUND;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(seg)) return NOT_FOUND;
      const i = Number(seg);
      if (i >= current.length) return NOT_FOUND;
      current = current[i];
    } else if (typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, seg)) return NOT_FOUND;
      current = (current as Record<string, unknown>)[seg];
    } else {
      // Primitives expose no addressable properties (no boxing).
      return NOT_FOUND;
    }
  }
  return { found: true, value: current };
}

// ---------------------------------------------------------------------------
// Regex safety gate (`matches` op)
// ---------------------------------------------------------------------------

/** Maximum accepted `matches` pattern length. */
export const MATCH_PATTERN_MAX_LENGTH = 200;

/**
 * Linear-time-safety HEURISTIC for `matches` patterns (see module comment):
 * length cap + banned-construct scan (backreferences, quantified groups).
 * Escapes and character classes are tracked so `\)`, `[)+]` etc. don't
 * false-positive.
 */
export function isSafeMatchPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > MATCH_PATTERN_MAX_LENGTH) return false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      // Backreferences: \1..\9 and named \k<...> — never linear-time.
      if (next !== undefined && next >= "1" && next <= "9") return false;
      if (next === "k") return false;
      i += 1; // skip the escaped char
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === ")") {
      const next = pattern[i + 1];
      // A quantifier applied to a group — the `(…)+`-style nested-quantifier
      // construct behind catastrophic backtracking.
      if (next === "+" || next === "*" || next === "{") return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Filter evaluation
// ---------------------------------------------------------------------------

/** The verdict of evaluating a trigger's filters against a payload. */
export interface FilterEvaluation {
  pass: boolean;
  /** Index of the first failing filter (absent when pass === true). */
  failedAt?: number;
}

/** Strict primitive equality (the eq/ne/contains element comparison). */
function primitiveEqual(a: unknown, b: unknown): boolean {
  return a === b;
}

/** Safe number coercion for the ordering ops: finite numbers and finite
 *  numeric strings only — no boolean/null/object coercion surprises. */
function toComparableNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Evaluates ONE filter (all comparisons are data-only; see module comment). */
function filterPasses(filter: TriggerFilter, payload: unknown): boolean {
  const { found, value } = resolvePath(payload, filter.path);
  switch (filter.op) {
    case "exists":
      return found && value !== undefined;
    case "eq":
      return found && primitiveEqual(value, filter.value);
    case "ne":
      // A missing/unresolvable field is "not equal" — ne passes.
      return !(found && primitiveEqual(value, filter.value));
    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      if (!found) return false;
      const a = toComparableNumber(value);
      const b = toComparableNumber(filter.value);
      if (a === undefined || b === undefined) return false;
      if (filter.op === "gt") return a > b;
      if (filter.op === "lt") return a < b;
      if (filter.op === "gte") return a >= b;
      return a <= b;
    }
    case "contains": {
      if (!found) return false;
      if (typeof value === "string") {
        if (filter.value === undefined || filter.value === null) return false;
        return value.includes(String(filter.value));
      }
      if (Array.isArray(value)) {
        return value.some((el) => primitiveEqual(el, filter.value));
      }
      return false;
    }
    case "matches": {
      if (!found) return false;
      if (typeof filter.value !== "string") return false;
      if (!isSafeMatchPattern(filter.value)) return false;
      let subject: string;
      if (typeof value === "string") subject = value;
      else if (typeof value === "number" || typeof value === "boolean") subject = String(value);
      else return false;
      // Hard-cap the evaluation input (defense in depth on top of the gate).
      const capped = subject.slice(0, MAPPING_FIELD_INTERPOLATION_MAX_CHARS);
      let re: RegExp;
      try {
        re = new RegExp(filter.value);
      } catch {
        return false;
      }
      return re.test(capped);
    }
  }
}

/**
 * Evaluates a trigger's declarative filters against an event payload. ALL
 * filters must pass; returns the index of the first failure otherwise.
 */
export function evaluateFilters(
  filters: TriggerFilter[],
  payload: unknown,
): FilterEvaluation {
  for (let i = 0; i < filters.length; i++) {
    const filter = filters[i];
    if (filter === undefined) continue;
    if (!filterPasses(filter, payload)) return { pass: false, failedAt: i };
  }
  return { pass: true };
}

// ---------------------------------------------------------------------------
// Prompt rendering (S1: single-pass, capped interpolation)
// ---------------------------------------------------------------------------

/** `{{ path.to.field }}` placeholder (whitespace-tolerant, non-greedy). */
const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** One interpolated value: strings verbatim, everything else JSON-stringified;
 *  always truncated to the per-field cap. */
function interpolationValue(value: unknown): string {
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else {
    try {
      s = JSON.stringify(value) ?? "";
    } catch {
      s = "";
    }
  }
  return s.slice(0, MAPPING_FIELD_INTERPOLATION_MAX_CHARS);
}

/**
 * Renders the trigger's promptTemplate against an event payload. SINGLE-PASS:
 * `String.replace` walks the TEMPLATE once and never rescans replacements, so
 * a payload value containing `{{x}}` is emitted literally — payload content
 * can never become a template (S1). Missing/unsafe paths render as "".
 */
export function renderPrompt(mapping: TriggerMapping, payload: unknown): string {
  const rendered = mapping.promptTemplate.replace(TOKEN_RE, (_match, rawPath: string) => {
    const { found, value } = resolvePath(payload, rawPath);
    if (!found || value === undefined) return "";
    return interpolationValue(value);
  });
  return rendered.slice(0, MAPPING_TOTAL_PROMPT_MAX_CHARS);
}

/** Truncates a string to at most `maxBytes` UTF-8 bytes without emitting a
 *  split code point (a trailing replacement char is stripped). */
function truncateUtf8Bytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let out = buf.subarray(0, maxBytes).toString("utf8");
  if (out.endsWith("�")) out = out.slice(0, -1);
  return out;
}

/**
 * Builds the AutoRunInput for a trigger fire:
 *   - `prompt` from renderPrompt (S1: the ONLY instruction source);
 *   - the raw payload attached as an inline FILE per `mapping.attachPayloadAs`
 *     (JSON.stringify, capped at EVENT_PAYLOAD_MAX_BYTES; skipped when the
 *     mapping opts out with null or there is no payload);
 *   - `input.event` carries `{ name }` metadata only (the payload travels as
 *     the attached file, never as free text).
 */
export function buildRunInput(
  mapping: TriggerMapping,
  payload: unknown,
  eventName: string,
): AutoRunInput {
  const input: AutoRunInput = {
    prompt: renderPrompt(mapping, payload),
    event: { name: eventName },
  };
  if (mapping.attachPayloadAs !== null && payload !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(payload) ?? "";
    } catch {
      serialized = "";
    }
    input.files = [
      {
        path: mapping.attachPayloadAs,
        content: truncateUtf8Bytes(serialized, EVENT_PAYLOAD_MAX_BYTES),
      },
    ];
  }
  return input;
}
