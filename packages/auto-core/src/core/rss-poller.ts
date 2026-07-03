/**
 * RSS/Atom feed poller (Wave 3b).
 *
 * For every enabled, due `rss` trigger the sweep fetches the feed (guarded by
 * the SAME SSRF policy as outbound webhooks — https-only, private/loopback/
 * link-local/metadata IPs rejected via the injected resolver — plus a timeout
 * and a 1 MiB response-size cap), extracts entries with a small tolerant
 * hand-rolled RSS2+Atom parser (NO new deps), dedupes on a guid seen-set
 * cursor, and feeds each NEW entry through the FULL consumeTriggerEvent gate
 * chain.
 *
 * INVARIANTS:
 *   - S1: the event payload is entry METADATA ({title,link,guid,publishedAt,
 *     feedUrl}) — data, never instructions; the promptTemplate remains the
 *     only instruction source.
 *   - PERSIST-BEFORE-DISPATCH: the seen-set (baseline + the guids about to be
 *     dispatched) is written before the first consume — no dupes across
 *     restarts/re-entrant sweeps.
 *   - NO-MISS: new entries beyond the per-sweep cap are NOT marked seen, so
 *     the next sweep picks them up.
 *   - BASELINE FIRST SWEEP: a brand-new trigger seeds the seen-set with the
 *     feed's current guids and fires nothing (no storm on an existing feed).
 */

import type { RssTriggerConfig } from "./types.js";
import type { DnsResolver, FetchFn } from "./http-fetch.js";
import { assertWebhookDestinationSafe } from "./delivery.js";
import {
  consumeTriggerEvent,
  type ConsumeTriggerEventDeps,
  type TriggerSweepSummary,
} from "./trigger-runner.js";
import {
  isPollDue,
  parsePollCursor,
  recordPollFailure,
  type PollCursorBase,
} from "./poll-cursor.js";

/** Max new entries dispatched per trigger per sweep. */
export const RSS_MAX_EVENTS_PER_SWEEP = 20;

/** Poll cadence floor/default (minutes) — feeds are polled gently. */
export const RSS_MIN_INTERVAL_MINUTES = 5;
export const RSS_DEFAULT_INTERVAL_MINUTES = 15;

/** Response-size cap (bytes) — a feed larger than this is refused. */
export const RSS_MAX_RESPONSE_BYTES = 1_048_576;

/** Feed-fetch timeout (ms) — mirrors the webhook delivery timeout. */
export const RSS_FETCH_TIMEOUT_MS = 10_000;

/** Max guids retained in the seen-set cursor (oldest evicted; feeds rotate). */
export const RSS_SEEN_GUIDS_MAX = 500;

/** The rss trigger's persisted cursor: guids already fired (newest first). */
export interface RssCursor extends PollCursorBase {
  seen: string[];
}

/** One parsed feed entry (RSS2 <item> or Atom <entry>). */
export interface RssFeedItem {
  title: string | null;
  link: string | null;
  /** Dedupe identity: guid/id, else link, else title. */
  guid: string;
  /** pubDate / published / updated, verbatim from the feed. */
  publishedAt: string | null;
}

/** Deps for the rss sweep: the consume gate chain + guarded egress seams. */
export interface RssPollDeps extends ConsumeTriggerEventDeps {
  fetchImpl: FetchFn;
  resolver: DnsResolver;
}

// ---------------------------------------------------------------------------
// Minimal tolerant RSS2 + Atom extraction (hand-rolled — no heavy XML dep)
// ---------------------------------------------------------------------------

/** Decodes the five XML entities + numeric character references. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Strips a CDATA wrapper (if any), trims, decodes entities. */
function cleanText(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  const text = cdata !== null ? (cdata[1] ?? "") : raw;
  return decodeEntities(text.trim());
}

/** First <tag>content</tag> inside a block (attributes tolerated), or null. */
function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(block);
  if (!m || m[1] === undefined) return null;
  const value = cleanText(m[1]);
  return value.length > 0 ? value : null;
}

/** Atom link: prefer rel="alternate", else the first <link href="…">. */
function extractAtomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>(?:<\/link>)?/gi)];
  let fallback: string | null = null;
  for (const m of links) {
    const attrs = m[1] ?? "";
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (href === undefined) continue;
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (rel === undefined || rel.toLowerCase() === "alternate") return decodeEntities(href);
    if (fallback === null) fallback = decodeEntities(href);
  }
  return fallback;
}

/**
 * Extracts entries from an RSS2 (<item>) or Atom (<entry>) document. Tolerant
 * by design: unknown markup is ignored; entries without any identity
 * (guid/id/link/title) are dropped.
 */
export function parseFeedItems(xml: string): RssFeedItem[] {
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ];
  const items: RssFeedItem[] = [];
  for (const m of blocks) {
    const block = m[1] ?? "";
    const title = extractTag(block, "title");
    // RSS2 <link>text</link>; Atom <link href="…"/>.
    const link = extractTag(block, "link") ?? extractAtomLink(block);
    const guidTag = extractTag(block, "guid") ?? extractTag(block, "id");
    const publishedAt =
      extractTag(block, "pubDate") ??
      extractTag(block, "published") ??
      extractTag(block, "updated");
    const guid = guidTag ?? link ?? title;
    if (guid === null) continue;
    items.push({ title, link, guid, publishedAt });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/**
 * Poll every due rss trigger once (cursor + dispatch discipline in the module
 * comment). Per-trigger isolation: one unreachable/oversized/SSRF-rejected
 * feed records an "error" fire log + circuit failure and never kills the
 * sweep.
 */
export async function runRssPollSweep(
  deps: RssPollDeps,
  now: string,
): Promise<TriggerSweepSummary> {
  const summary: TriggerSweepSummary = { processed: 0, dispatched: 0, skipped: 0, errors: [] };

  const due = await deps.triggers.listDue("rss", now);

  for (const trigger of due) {
    if (trigger.type !== "rss") {
      summary.errors.push({ triggerId: trigger.id, error: "listDue returned a non-rss trigger." });
      continue;
    }
    const config: RssTriggerConfig = trigger.config;

    const cursor = parsePollCursor<RssCursor>(trigger.cursor);
    const intervalMinutes = Math.max(
      RSS_MIN_INTERVAL_MINUTES,
      config.intervalMinutes ?? RSS_DEFAULT_INTERVAL_MINUTES,
    );
    if (!isPollDue(cursor, intervalMinutes, now)) continue;

    summary.processed += 1;

    const fail = async (detail: string): Promise<void> => {
      summary.errors.push({ triggerId: trigger.id, error: detail });
      await recordPollFailure(deps, trigger.id, now, detail);
      if (cursor !== null) {
        try {
          await deps.triggers.updateCursor(
            trigger.id,
            JSON.stringify({ ...cursor, polledAt: now } satisfies RssCursor),
          );
        } catch {
          /* best-effort */
        }
      }
    };

    try {
      // ---- Guarded fetch (same SSRF policy as outbound webhooks) ------------
      await assertWebhookDestinationSafe(config.feedUrl, deps.resolver);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT_MS);
      let body: string;
      let status: number;
      try {
        const res = await deps.fetchImpl(config.feedUrl, {
          method: "GET",
          headers: { "user-agent": "AgentKitAuto-FeedPoller/1", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
          signal: controller.signal,
        });
        status = res.status;
        body = await res.text();
      } finally {
        clearTimeout(timer);
      }
      if (status < 200 || status >= 300) {
        await fail(`Feed responded with HTTP ${status}.`);
        continue;
      }
      if (Buffer.byteLength(body, "utf8") > RSS_MAX_RESPONSE_BYTES) {
        await fail(`Feed exceeds the ${RSS_MAX_RESPONSE_BYTES}-byte response cap.`);
        continue;
      }

      // ---- Parse + dedupe -----------------------------------------------------
      const items = parseFeedItems(body);

      // Baseline first sweep: seed the seen-set, fire nothing.
      if (cursor === null) {
        const baseline: RssCursor = {
          v: 1,
          polledAt: now,
          seen: items.map((i) => i.guid).slice(0, RSS_SEEN_GUIDS_MAX),
        };
        await deps.triggers.updateCursor(trigger.id, JSON.stringify(baseline));
        summary.skipped += 1;
        continue;
      }

      const seen = new Set(cursor.seen);
      const fresh: RssFeedItem[] = [];
      const freshGuids = new Set<string>();
      for (const item of items) {
        if (seen.has(item.guid) || freshGuids.has(item.guid)) continue;
        freshGuids.add(item.guid);
        fresh.push(item);
      }
      const toDispatch = fresh.slice(0, RSS_MAX_EVENTS_PER_SWEEP);

      // ---- Advance the cursor (PERSIST BEFORE DISPATCH) ------------------------
      // Only the entries about to be dispatched join the seen-set; capped
      // leftovers stay unseen for the next sweep (no-miss).
      const nextCursor: RssCursor = {
        v: 1,
        polledAt: now,
        seen: [...toDispatch.map((i) => i.guid), ...cursor.seen].slice(0, RSS_SEEN_GUIDS_MAX),
      };
      try {
        await deps.triggers.updateCursor(trigger.id, JSON.stringify(nextCursor));
      } catch (err) {
        summary.errors.push({
          triggerId: trigger.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue; // cursor not advanced → do NOT dispatch (no-dupe wins).
      }

      if (toDispatch.length === 0) {
        summary.skipped += 1;
        continue;
      }

      // ---- Dispatch through the FULL gate chain --------------------------------
      for (const item of toDispatch) {
        const log = await consumeTriggerEvent(
          trigger,
          {
            name: "rss_item",
            payload: {
              title: item.title,
              link: item.link,
              guid: item.guid,
              publishedAt: item.publishedAt,
              feedUrl: config.feedUrl,
            },
            receivedAt: now,
          },
          deps,
        );
        if (log.outcome === "run_created") summary.dispatched += 1;
        else if (log.outcome === "error") {
          summary.errors.push({ triggerId: trigger.id, error: log.detail ?? "Fire errored." });
        } else summary.skipped += 1;
      }
    } catch (err) {
      await fail(err instanceof Error ? err.message : String(err));
    }
  }

  return summary;
}
