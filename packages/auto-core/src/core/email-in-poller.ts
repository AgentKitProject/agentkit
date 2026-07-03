/**
 * Email-in poller (Wave 4 — the `email_in` trigger).
 *
 * HOSTED PATH (SES inbound → S3): SES writes each inbound message's raw MIME
 * to ONE operator-level bucket/prefix (env `AUTO_EMAIL_INBOX_BUCKET` /
 * `AUTO_EMAIL_INBOX_PREFIX`; addresses live under `AUTO_EMAIL_INBOX_DOMAIN`,
 * e.g. `<addressSlug>@in.agentkitproject.com`). For every enabled, due
 * `email_in` trigger the sweep lists new objects (3b seen-set cursor pattern,
 * baseline first sweep — no storm on a pre-populated inbox), parses each new
 * message with a small TOLERANT hand-rolled MIME reader (headers +
 * `text/plain` body, FIRST level of multipart only, base64/quoted-printable
 * decoding — NO heavy dependency), routes by TO-address match against the
 * trigger's server-generated `config.addressSlug`, applies the sender
 * allowlist, and feeds matches through the FULL consumeTriggerEvent gate
 * chain.
 *
 * SELF-HOST PATH (IMAP): `config.connectionId` references an `imap`
 * Connection (host/port in config, credentials in the SecretStore). The full
 * IMAP client is OUT OF SCOPE for this wave — the sweep detects the shape and
 * SKIPS such triggers cleanly (counted as skipped; no error spam, no circuit
 * penalty), exactly like every other unconfigured integration.
 *
 * SAFETY / INVARIANTS:
 *   - S1: the event payload is {from,to,subject,receivedAt,bodyText} — DATA
 *     only; bodyText is truncated to EMAIL_IN_BODY_MAX_CHARS and interpolated
 *     only where the promptTemplate references it (evaluator caps apply).
 *   - SENDER ALLOWLIST: config.allowedFrom non-empty → the From addr-spec must
 *     match (case-insensitive). EMPTY = only the trigger OWNER's verified
 *     email may fire — resolved via the injected `getOwnerEmail` seam; when
 *     the seam is unwired/unresolvable the poller FAILS CLOSED (fire-log
 *     "filtered", never a run). Non-matching senders → fire-log "filtered".
 *   - PERSIST-BEFORE-DISPATCH: examined keys join the seen-set cursor BEFORE
 *     any consume (no-dupe beats no-miss, like watch/rss).
 *   - The operator inbox bucket is read with AMBIENT AWS credentials (task
 *     role / env chain) — it is operator infrastructure, NOT a per-user
 *     connection; nothing here touches the SecretStore.
 *   - Unconfigured (no bucket/domain) → the sweep is INERT (skips, no errors).
 */

import type { EmailInTriggerConfig, Trigger } from "./types.js";
import { EMAIL_IN_BODY_MAX_CHARS } from "./types.js";
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

/** Poll cadence for email_in triggers (minutes; config carries no interval). */
export const EMAIL_IN_POLL_INTERVAL_MINUTES = 1;

/** Max inbox objects fetched+parsed per trigger per sweep. */
export const EMAIL_IN_MAX_FETCHES_PER_SWEEP = 50;

/** Max matched emails dispatched per trigger per sweep. */
export const EMAIL_IN_MAX_EVENTS_PER_SWEEP = 20;

/** Max raw-MIME bytes read per message (larger messages are truncated at the
 *  read seam; the parsed body is separately capped at EMAIL_IN_BODY_MAX_CHARS). */
export const EMAIL_IN_MAX_OBJECT_BYTES = 1_048_576;

/** Max inbox objects one listing may return (a fuller inbox needs pruning —
 *  the operator should expire delivered objects). */
export const EMAIL_IN_MAX_LIST_OBJECTS = 1000;

/** Max keys retained in the seen-set cursor (oldest evicted). */
export const EMAIL_IN_SEEN_KEYS_MAX = 2000;

/** The email_in trigger's persisted cursor: inbox keys already examined. */
export interface EmailInCursor extends PollCursorBase {
  seen: string[];
}

/** Operator inbox configuration (env-sourced by the app layer). */
export interface EmailInboxConfig {
  bucket: string;
  /** Key prefix within the bucket ("" = whole bucket). */
  prefix: string;
  /** Inbound address domain (`<slug>@<domain>`). */
  domain: string;
  region?: string;
  /** S3-compatible endpoint override (MinIO etc.). */
  endpoint?: string;
}

/** One listed inbox object. */
export interface InboxObjectSummary {
  key: string;
  lastModified: string;
}

/** Injected inbox list seam (ambient AWS credentials; tests inject). */
export type InboxListFn = (args: {
  inbox: EmailInboxConfig;
  maxKeys: number;
}) => Promise<InboxObjectSummary[]>;

/** Injected inbox object reader (raw MIME text, byte-capped). */
export type InboxGetFn = (args: {
  inbox: EmailInboxConfig;
  key: string;
  maxBytes: number;
}) => Promise<string>;

async function defaultInboxList(args: Parameters<InboxListFn>[0]): Promise<InboxObjectSummary[]> {
  const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const { inbox } = args;
  const client = new S3Client({
    region: inbox.region ?? "us-east-1",
    ...(inbox.endpoint ? { endpoint: inbox.endpoint, forcePathStyle: true } : {}),
  });
  const objects: InboxObjectSummary[] = [];
  try {
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: inbox.bucket,
          ...(inbox.prefix.length > 0 ? { Prefix: inbox.prefix } : {}),
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const obj of page.Contents ?? []) {
        if (!obj.Key) continue;
        objects.push({ key: obj.Key, lastModified: obj.LastModified?.toISOString() ?? "" });
        if (objects.length >= args.maxKeys) return objects;
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return objects;
  } finally {
    client.destroy();
  }
}

async function defaultInboxGet(args: Parameters<InboxGetFn>[0]): Promise<string> {
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { inbox } = args;
  const client = new S3Client({
    region: inbox.region ?? "us-east-1",
    ...(inbox.endpoint ? { endpoint: inbox.endpoint, forcePathStyle: true } : {}),
  });
  try {
    const res = await client.send(
      new GetObjectCommand({
        Bucket: inbox.bucket,
        Key: args.key,
        Range: `bytes=0-${args.maxBytes - 1}`,
      }),
    );
    const body = res.Body;
    if (!body) return "";
    return await (body as { transformToString(enc?: string): Promise<string> }).transformToString(
      "utf-8",
    );
  } finally {
    client.destroy();
  }
}

// ---------------------------------------------------------------------------
// Minimal tolerant MIME parsing (hand-rolled — no heavy dependency)
// ---------------------------------------------------------------------------

/** The parsed subset of one inbound message (the S1 event payload source). */
export interface ParsedInboundEmail {
  /** First From addr-spec (lowercased). */
  from: string;
  /** Every To addr-spec (lowercased). */
  to: string[];
  subject: string;
  /** Date header verbatim (may be empty). */
  date: string;
  /** Decoded text/plain body, truncated to EMAIL_IN_BODY_MAX_CHARS. */
  bodyText: string;
}

/** RFC 2047 encoded-word decoding (utf-8/latin tolerated; B and Q forms). */
function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (whole, _charset: string, form: string, text: string) => {
      try {
        if (form === "b" || form === "B") {
          return Buffer.from(text, "base64").toString("utf8");
        }
        // Q form: underscore = space; =XX = byte.
        const bytes: number[] = [];
        for (let i = 0; i < text.length; i++) {
          const ch = text[i]!;
          if (ch === "_") bytes.push(0x20);
          else if (ch === "=" && i + 2 < text.length + 1) {
            const hex = text.slice(i + 1, i + 3);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
              bytes.push(Number.parseInt(hex, 16));
              i += 2;
            } else bytes.push(ch.charCodeAt(0));
          } else bytes.push(ch.charCodeAt(0));
        }
        return Buffer.from(bytes).toString("utf8");
      } catch {
        return whole;
      }
    },
  );
}

/** Decodes a quoted-printable body (soft line breaks + =XX escapes). */
function decodeQuotedPrintable(text: string): string {
  const noSoftBreaks = text.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < noSoftBreaks.length; i++) {
    const ch = noSoftBreaks[i]!;
    if (ch === "=" && /^[0-9a-fA-F]{2}$/.test(noSoftBreaks.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(noSoftBreaks.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = ch.codePointAt(0)!;
      if (code < 128) bytes.push(code);
      else {
        for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      }
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Splits a raw RFC 822 block into unfolded headers + body. */
function splitHeadersAndBody(raw: string): { headers: Map<string, string>; body: string } | null {
  const normalized = raw.replace(/\r\n/g, "\n");
  const sep = normalized.indexOf("\n\n");
  const headerBlock = sep === -1 ? normalized : normalized.slice(0, sep);
  const body = sep === -1 ? "" : normalized.slice(sep + 2);
  const headers = new Map<string, string>();
  let currentName: string | undefined;
  for (const line of headerBlock.split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && currentName !== undefined) {
      headers.set(currentName, `${headers.get(currentName) ?? ""} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      currentName = undefined;
      continue; // tolerate junk lines
    }
    currentName = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // First occurrence wins (tolerates duplicated headers).
    if (!headers.has(currentName)) headers.set(currentName, value);
  }
  if (headers.size === 0) return null;
  return { headers, body };
}

/** Extracts addr-specs (lowercased) from an address header value. */
export function extractAddresses(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  const decoded = decodeEncodedWords(headerValue);
  const matches = decoded.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  return [...new Set(matches.map((a) => a.toLowerCase()))];
}

/** Content-Type value + params (boundary/charset), tolerant. */
function parseContentType(value: string | undefined): { type: string; boundary?: string } {
  if (!value) return { type: "text/plain" };
  const [typePart, ...paramParts] = value.split(";");
  const type = (typePart ?? "text/plain").trim().toLowerCase();
  let boundary: string | undefined;
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() === "boundary") {
      boundary = part
        .slice(eq + 1)
        .trim()
        .replace(/^"(.*)"$/, "$1");
    }
  }
  return { type, boundary };
}

/** Decodes a body per its Content-Transfer-Encoding (tolerant). */
function decodeBody(body: string, encoding: string | undefined): string {
  const enc = (encoding ?? "").trim().toLowerCase();
  if (enc === "base64") {
    try {
      return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return body;
    }
  }
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

/**
 * Parses one raw MIME message TOLERANTLY: From/To/Subject/Date + the decoded
 * text/plain body (first level of multipart only — a nested multipart's first
 * part is used verbatim). Returns null for malformed input (no headers, or no
 * From AND no To) — the poller SKIPS such objects (marked seen, no event).
 */
export function parseInboundEmail(raw: string): ParsedInboundEmail | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const parsed = splitHeadersAndBody(raw);
  if (parsed === null) return null;
  const { headers, body } = parsed;

  const fromAddresses = extractAddresses(headers.get("from"));
  const toAddresses = extractAddresses(headers.get("to"));
  if (fromAddresses.length === 0 && toAddresses.length === 0) return null;

  const { type, boundary } = parseContentType(headers.get("content-type"));

  let bodyText: string;
  if (type.startsWith("multipart/") && boundary !== undefined && boundary.length > 0) {
    // First level only: split on the boundary, pick the first text/plain part
    // (else the first part at all), decode its transfer encoding.
    const marker = `--${boundary}`;
    const segments = body
      .split(marker)
      .slice(1) // preamble
      .filter((s) => !s.startsWith("--")); // closing marker
    let chosen: { headers: Map<string, string>; body: string } | null = null;
    for (const segment of segments) {
      const part = splitHeadersAndBody(segment.replace(/^\n/, ""));
      if (part === null) continue;
      const partType = parseContentType(part.headers.get("content-type")).type;
      if (partType === "text/plain") {
        chosen = part;
        break;
      }
      if (chosen === null) chosen = part;
    }
    bodyText =
      chosen !== null
        ? decodeBody(chosen.body, chosen.headers.get("content-transfer-encoding"))
        : "";
  } else {
    bodyText = decodeBody(body, headers.get("content-transfer-encoding"));
  }

  bodyText = bodyText.trim();
  if (bodyText.length > EMAIL_IN_BODY_MAX_CHARS) {
    bodyText = `${bodyText.slice(0, EMAIL_IN_BODY_MAX_CHARS)}\n…[truncated]`;
  }

  return {
    from: fromAddresses[0] ?? "",
    to: toAddresses,
    subject: decodeEncodedWords(headers.get("subject") ?? "").trim(),
    date: headers.get("date") ?? "",
    bodyText,
  };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/** Deps for the email-in sweep. */
export interface EmailInPollDeps extends ConsumeTriggerEventDeps {
  /** Operator inbox config (env-sourced). ABSENT = the sweep is inert. */
  inbox?: EmailInboxConfig;
  /** Injected list/get seams (tests); default to ambient-credential clients. */
  listInbox?: InboxListFn;
  getInboxObject?: InboxGetFn;
  /**
   * Resolves a trigger owner's verified email (the DEFAULT allowlist when
   * config.allowedFrom is empty). TODO(seam): wire to the identity store; an
   * unwired/unresolvable owner email FAILS CLOSED (filtered, never a run).
   */
  getOwnerEmail?: (userId: string) => Promise<string | undefined>;
}

/**
 * Poll every due email_in trigger once. Hosted-inbox path only; IMAP
 * (config.connectionId) triggers are skipped cleanly (see the module header).
 */
export async function runEmailInPollSweep(
  deps: EmailInPollDeps,
  now: string,
): Promise<TriggerSweepSummary> {
  const summary: TriggerSweepSummary = { processed: 0, dispatched: 0, skipped: 0, errors: [] };
  const list = deps.listInbox ?? defaultInboxList;
  const get = deps.getInboxObject ?? defaultInboxGet;

  const due = await deps.triggers.listDue("email_in", now);

  for (const trigger of due) {
    if (trigger.type !== "email_in") {
      summary.errors.push({ triggerId: trigger.id, error: "listDue returned a non-email_in trigger." });
      continue;
    }
    const config: EmailInTriggerConfig = trigger.config;

    // Self-host IMAP shape → clean skip (full IMAP client is out of scope).
    if (config.connectionId !== null && config.connectionId !== undefined) {
      summary.skipped += 1;
      continue;
    }
    // Unconfigured hosted inbox / no generated address → inert.
    if (!deps.inbox || config.addressSlug === null || config.addressSlug === undefined) {
      summary.skipped += 1;
      continue;
    }
    const inbox = deps.inbox;
    const triggerAddress = `${config.addressSlug}@${inbox.domain}`.toLowerCase();

    const cursor = parsePollCursor<EmailInCursor>(trigger.cursor);
    if (!isPollDue(cursor, EMAIL_IN_POLL_INTERVAL_MINUTES, now)) continue;

    summary.processed += 1;

    const fail = async (detail: string): Promise<void> => {
      summary.errors.push({ triggerId: trigger.id, error: detail });
      await recordPollFailure(deps, trigger.id, now, detail);
      if (cursor !== null) {
        try {
          await deps.triggers.updateCursor(
            trigger.id,
            JSON.stringify({ ...cursor, polledAt: now } satisfies EmailInCursor),
          );
        } catch {
          /* best-effort */
        }
      }
    };

    try {
      const listed = await list({ inbox, maxKeys: EMAIL_IN_MAX_LIST_OBJECTS });

      // Baseline first sweep: seed the seen-set, fire nothing.
      if (cursor === null) {
        const baseline: EmailInCursor = {
          v: 1,
          polledAt: now,
          seen: listed.map((o) => o.key).slice(0, EMAIL_IN_SEEN_KEYS_MAX),
        };
        await deps.triggers.updateCursor(trigger.id, JSON.stringify(baseline));
        summary.skipped += 1;
        continue;
      }

      const seen = new Set(cursor.seen);
      const fresh = listed
        .filter((o) => !seen.has(o.key))
        .sort((a, b) =>
          a.lastModified === b.lastModified
            ? a.key.localeCompare(b.key)
            : a.lastModified.localeCompare(b.lastModified),
        )
        .slice(0, EMAIL_IN_MAX_FETCHES_PER_SWEEP);

      // Fetch + parse + route. Examined keys are marked seen regardless of
      // match (mail for OTHER triggers is their sweep's business — every
      // trigger keeps its own cursor over the shared inbox).
      interface MatchedEmail {
        key: string;
        email: ParsedInboundEmail;
      }
      const matched: MatchedEmail[] = [];
      const filtered: MatchedEmail[] = [];
      const examinedKeys: string[] = [];
      let ownerEmail: string | undefined;
      let ownerEmailResolved = false;
      for (const object of fresh) {
        // Event cap: stop EXAMINING entirely — un-examined keys stay out of
        // the seen-set, so the next sweep picks them up (no-miss).
        if (matched.length >= EMAIL_IN_MAX_EVENTS_PER_SWEEP) break;
        examinedKeys.push(object.key);
        let email: ParsedInboundEmail | null;
        try {
          email = parseInboundEmail(
            await get({ inbox, key: object.key, maxBytes: EMAIL_IN_MAX_OBJECT_BYTES }),
          );
        } catch {
          continue; // unreadable object → skip (stays seen; no event)
        }
        if (email === null) continue; // malformed → skip
        if (!email.to.includes(triggerAddress)) continue; // not our address

        // Sender allowlist (S1 abuse guard): explicit list, else owner-only.
        // (Legacy rows may predate the allowedFrom contract default.)
        const allowedFrom = config.allowedFrom ?? [];
        let allowed: boolean;
        if (allowedFrom.length > 0) {
          allowed = allowedFrom.some((a) => a.toLowerCase() === email.from);
        } else {
          if (!ownerEmailResolved) {
            ownerEmailResolved = true;
            try {
              ownerEmail = deps.getOwnerEmail
                ? (await deps.getOwnerEmail(trigger.userId))?.toLowerCase()
                : undefined;
            } catch {
              ownerEmail = undefined;
            }
          }
          // FAIL CLOSED: no resolvable owner email → nothing may fire.
          allowed = ownerEmail !== undefined && ownerEmail === email.from;
        }
        if (!allowed) filtered.push({ key: object.key, email });
        else matched.push({ key: object.key, email });
      }

      // PERSIST BEFORE DISPATCH: every EXAMINED key joins the seen-set (a
      // dispatched/filtered/foreign/malformed mail is done); keys past the
      // event cap were never examined and stay unseen for the next sweep.
      const nextSeen = [...examinedKeys, ...cursor.seen].slice(0, EMAIL_IN_SEEN_KEYS_MAX);
      const nextCursor: EmailInCursor = { v: 1, polledAt: now, seen: nextSeen };
      try {
        await deps.triggers.updateCursor(trigger.id, JSON.stringify(nextCursor));
      } catch (err) {
        summary.errors.push({
          triggerId: trigger.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue; // cursor not advanced → do NOT dispatch (no-dupe wins).
      }

      // Non-matching senders → fire-log "filtered" (observability, no run).
      for (const { email } of filtered) {
        try {
          await deps.fireLogs.appendFireLog({
            triggerId: trigger.id,
            at: now,
            outcome: "filtered",
            runId: null,
            detail: `Sender ${email.from} is not on the allowlist.`,
          });
        } catch {
          /* best-effort */
        }
        summary.skipped += 1;
      }

      if (matched.length === 0 && filtered.length === 0) {
        summary.skipped += 1;
        continue;
      }

      // Dispatch through the FULL gate chain (payload is DATA — S1).
      for (const { email } of matched) {
        const receivedAt =
          email.date.length > 0 && Number.isFinite(Date.parse(email.date))
            ? new Date(Date.parse(email.date)).toISOString()
            : now;
        const log = await consumeTriggerEvent(
          trigger,
          {
            name: "email_received",
            payload: {
              from: email.from,
              to: triggerAddress,
              subject: email.subject,
              receivedAt,
              bodyText: email.bodyText,
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
