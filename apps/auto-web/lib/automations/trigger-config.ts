// Pure builders for the wizard's three additional trigger kinds — RSS
// (kind "rss"), kit-chaining (kind "run_completed"), and inbound email
// (kind "email_in"). Kept UI-free so they are unit-testable in the node
// vitest environment (the TriggerWizard JSX imports these), mirroring
// watch-connect.ts's buildWatchConfig pattern.
//
// Each returns the exact per-type config object the contracts discriminated
// createTriggerRequestSchema expects (auto-events.ts):
//   - rssTriggerConfigSchema:          { feedUrl, intervalMinutes 5–1440 }
//   - runCompletedTriggerConfigSchema: { kitRef?, statuses, sourceTriggerId? }
//   - emailInTriggerConfigSchema:      { allowedFrom } (address/addressSlug are
//                                        SERVER-owned — never sent from here).

import type { KitRef, RunTerminalStatus } from "@agentkitforge/contracts";

// ---------------------------------------------------------------------------
// RSS
// ---------------------------------------------------------------------------

export interface RssConfigFields {
  feedUrl: string;
  intervalMinutes: number;
}

/** The rssTriggerConfig object (contract shape) from the wizard fields. The
 *  interval is clamped to the contract's 5–1440 window (default 15); the feed
 *  URL is trimmed but its https-validity is enforced by the contract schema
 *  (and pre-flighted by the wizard's whenReady). */
export function buildRssConfig(fields: RssConfigFields) {
  return {
    feedUrl: fields.feedUrl.trim(),
    intervalMinutes: Math.min(1440, Math.max(5, Math.trunc(fields.intervalMinutes) || 15))
  };
}

/** True when a feed URL is a syntactically-valid https:// URL (the same rule
 *  the contract's httpsUrlSchema enforces server-side) — drives whenReady. */
export function isValidFeedUrl(feedUrl: string): boolean {
  const url = feedUrl.trim();
  if (!url.startsWith("https://")) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Kit chaining (run_completed)
// ---------------------------------------------------------------------------

/** The terminal run statuses a run_completed trigger can subscribe to, with
 *  human labels (matches runTerminalStatusSchema exactly). */
export const RUN_TERMINAL_STATUSES: { status: RunTerminalStatus; label: string }[] = [
  { status: "succeeded", label: "Succeeded" },
  { status: "failed", label: "Failed" },
  { status: "canceled", label: "Canceled" },
  { status: "budget_exceeded", label: "Budget exceeded" }
];

export interface RunCompletedConfigFields {
  /** The kit to chain off, or null for "any kit". */
  kitRef: KitRef | null;
  /** Terminal statuses that fire the chain (order-normalized; at least one). */
  statuses: RunTerminalStatus[];
  /** Optional: restrict to runs fired by this specific trigger. */
  sourceTriggerId?: string | null;
}

/** The runCompletedTriggerConfig object (contract shape). Statuses are
 *  de-duplicated and canonically ordered; an empty selection falls back to the
 *  contract default ["succeeded"] (whenReady also requires ≥1). kitRef and
 *  sourceTriggerId are omitted when absent (null/absent = "any"). */
export function buildRunCompletedConfig(fields: RunCompletedConfigFields) {
  const ordered = RUN_TERMINAL_STATUSES.map((s) => s.status).filter((s) => fields.statuses.includes(s));
  const statuses = ordered.length > 0 ? ordered : (["succeeded"] as RunTerminalStatus[]);
  const sourceTriggerId = fields.sourceTriggerId?.trim();
  return {
    ...(fields.kitRef ? { kitRef: fields.kitRef } : {}),
    statuses,
    ...(sourceTriggerId ? { sourceTriggerId } : {})
  };
}

// ---------------------------------------------------------------------------
// Email-in
// ---------------------------------------------------------------------------

export interface EmailInConfigFields {
  /** Allowed From addresses (empty = only the owner's verified email). */
  allowedFrom: string[];
}

/** The emailInTriggerConfig object (contract shape) from the wizard fields.
 *  The wizard NEVER sends address/addressSlug — the server mints them on create
 *  (hard rule: the server owns generated identifiers). connectionId (self-host
 *  IMAP) is out of scope here and always omitted. Allowlist entries are
 *  trimmed, lowercased (addr-spec is case-insensitive), de-duplicated, and
 *  capped at the contract max (20). */
export function buildEmailInConfig(fields: EmailInConfigFields) {
  const seen = new Set<string>();
  const allowedFrom: string[] = [];
  for (const raw of fields.allowedFrom) {
    const addr = raw.trim().toLowerCase();
    if (addr.length === 0 || seen.has(addr)) continue;
    seen.add(addr);
    allowedFrom.push(addr);
    if (allowedFrom.length >= 20) break;
  }
  return { allowedFrom };
}

/** Split a free-text allowlist entry box (comma/newline/space-separated) into
 *  candidate addresses — the wizard's list input helper. */
export function parseAllowlistInput(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

/** Very small addr-spec sanity check for the allowlist input (the contract's
 *  z.string().email() is the authority; this just guards the add button). */
export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
