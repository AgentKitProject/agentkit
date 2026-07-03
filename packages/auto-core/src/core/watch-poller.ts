/**
 * Folder-watch poller (Wave 3b — the flagship polled trigger).
 *
 * For every enabled, due `watch` trigger the sweep lists the S3-compatible
 * bucket behind the trigger's Connection (prefix-scoped), diffs the listing
 * against the persisted cursor (a key → etag map — exact created/updated
 * detection with no clock skew), and feeds one synthesized event per
 * new/changed object through the FULL consumeTriggerEvent gate chain (no
 * bypass — filters, rate cap, canStartRun, approval, circuit all apply).
 *
 * SAFETY / INVARIANTS:
 *   - S1: the event payload is METADATA ONLY ({key,size,etag,lastModified,
 *     eventName}) — object CONTENTS never enter the event or the prompt; a kit
 *     that needs the bytes reads them through its own run-input mechanisms.
 *   - S2: connection credentials are revealed from the SecretStore ONLY here
 *     (server/sweep side) and handed straight to the injected S3 client —
 *     never onto the trigger, the event, or any log.
 *   - PERSIST-BEFORE-DISPATCH (no-dupe beats no-miss, exactly like
 *     runDueScheduleTriggers): the advanced cursor — baseline + the objects
 *     about to be dispatched — is written before the first consume. A crash
 *     mid-dispatch loses at most that batch; it can never double-fire.
 *   - NO-MISS ACROSS SWEEPS: detected-but-undispatched objects (beyond the
 *     per-sweep cap) are NOT folded into the cursor, so the next sweep picks
 *     them up; a changed object keeps its OLD etag in the cursor until its
 *     update event is actually dispatched.
 *   - BASELINE FIRST SWEEP: a brand-new trigger (no cursor) only records the
 *     current listing — no event storm on a pre-populated bucket — unless
 *     config.includeExisting is true.
 *   - Deleted objects leave the cursor silently (no event).
 */

import type { ConnectionRepository, SecretStore } from "./ports.js";
import type { Trigger, WatchTriggerConfig } from "./types.js";
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
import { isSafeMatchPattern } from "./mapping-evaluator.js";
import { parseS3ConnectionSecret } from "./destination-executor.js";

/** Max object events dispatched per trigger per sweep (the rest are picked up
 *  by the next sweep — log-and-continue, never a storm). */
export const WATCH_MAX_EVENTS_PER_SWEEP = 50;

/** Poll cadence floor/default (minutes). */
export const WATCH_MIN_INTERVAL_MINUTES = 1;
export const WATCH_DEFAULT_INTERVAL_MINUTES = 5;

/** Max objects a listing tracks in the cursor (abuse/size guard: a prefix
 *  bigger than this is refused — watch a narrower prefix instead). */
export const WATCH_MAX_TRACKED_OBJECTS = 10_000;

/** The watch trigger's persisted cursor: the last-acknowledged listing as a
 *  key → etag map (exact new/changed diffing across restarts). */
export interface WatchCursor extends PollCursorBase {
  objects: Record<string, string>;
}

/** One listed object (the metadata that becomes the event payload — S1). */
export interface S3ObjectSummary {
  key: string;
  size: number;
  etag: string;
  lastModified: string;
}

/** Server-side S3 list seam. Injectable for tests; the default lazy-imports
 *  @aws-sdk/client-s3 and paginates ListObjectsV2 (mirrors the
 *  destination-executor's S3PutObjectFn pattern). */
export type S3ListObjectsFn = (args: {
  endpoint?: string;
  region?: string;
  forcePathStyle?: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
  bucket: string;
  prefix: string;
  /** Hard cap on returned objects (listing stops once reached). */
  maxKeys: number;
}) => Promise<S3ObjectSummary[]>;

async function defaultS3List(args: Parameters<S3ListObjectsFn>[0]): Promise<S3ObjectSummary[]> {
  const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: args.region ?? "us-east-1",
    ...(args.endpoint ? { endpoint: args.endpoint, forcePathStyle: args.forcePathStyle ?? true } : {}),
    credentials: args.credentials,
  });
  const objects: S3ObjectSummary[] = [];
  try {
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: args.bucket,
          ...(args.prefix.length > 0 ? { Prefix: args.prefix } : {}),
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const obj of page.Contents ?? []) {
        if (!obj.Key) continue;
        objects.push({
          key: obj.Key,
          size: obj.Size ?? 0,
          etag: (obj.ETag ?? "").replace(/"/g, ""),
          lastModified: obj.LastModified?.toISOString() ?? "",
        });
        if (objects.length >= args.maxKeys) return objects;
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return objects;
  } finally {
    client.destroy();
  }
}

/** Deps for the watch sweep: the consume gate chain + the connection/secret
 *  stores (S2: reveal happens only inside this sweep) + the list seam. */
export interface WatchPollDeps extends ConsumeTriggerEventDeps {
  connections: ConnectionRepository;
  secrets: SecretStore;
  /** Injectable list seam (tests); defaults to the real paginated client. */
  s3List?: S3ListObjectsFn;
}

/** One detected change (becomes one per_file event / one per_batch entry). */
interface DetectedChange {
  object: S3ObjectSummary;
  eventName: "object_created" | "object_updated";
}

function joinPrefix(a: string | undefined, b: string): string {
  const left = (a ?? "").replace(/^\/+|\/+$/g, "");
  const right = b.replace(/^\/+/, "");
  if (left.length === 0) return right;
  if (right.length === 0) return left.endsWith("/") ? left : `${left}/`;
  return `${left}/${right}`;
}

function basename(key: string): string {
  const idx = key.lastIndexOf("/");
  return idx >= 0 ? key.slice(idx + 1) : key;
}

/**
 * Poll every due watch trigger once (see the module comment for the cursor +
 * dispatch discipline). Per-trigger isolation: one failing bucket/connection
 * records an "error" fire log + circuit failure and never kills the sweep.
 */
export async function runWatchPollSweep(
  deps: WatchPollDeps,
  now: string,
): Promise<TriggerSweepSummary> {
  const summary: TriggerSweepSummary = { processed: 0, dispatched: 0, skipped: 0, errors: [] };
  const list = deps.s3List ?? defaultS3List;

  const due = await deps.triggers.listDue("watch", now);

  for (const trigger of due) {
    if (trigger.type !== "watch") {
      summary.errors.push({ triggerId: trigger.id, error: "listDue returned a non-watch trigger." });
      continue;
    }
    const config: WatchTriggerConfig = trigger.config;

    // Interval gate — a trigger polled more recently than its cadence is not
    // due yet (not counted as processed).
    const cursor = parsePollCursor<WatchCursor>(trigger.cursor);
    const intervalMinutes = Math.max(
      WATCH_MIN_INTERVAL_MINUTES,
      config.intervalMinutes ?? WATCH_DEFAULT_INTERVAL_MINUTES,
    );
    if (!isPollDue(cursor, intervalMinutes, now)) continue;

    summary.processed += 1;

    /** Poll-level failure: error fire-log + circuit, and (with an EXISTING
     *  cursor) advance polledAt so a broken source retries next interval, not
     *  next sweep. A missing baseline is never fabricated (see poll-cursor). */
    const fail = async (detail: string): Promise<void> => {
      summary.errors.push({ triggerId: trigger.id, error: detail });
      await recordPollFailure(deps, trigger.id, now, detail);
      if (cursor !== null) {
        try {
          await deps.triggers.updateCursor(
            trigger.id,
            JSON.stringify({ ...cursor, polledAt: now } satisfies WatchCursor),
          );
        } catch {
          /* best-effort */
        }
      }
    };

    try {
      // ---- Resolve the connection + credentials (S2: reveal stays here) ----
      const connection = await deps.connections.getConnection(config.connectionId);
      if (!connection) {
        await fail("Watch connection not found.");
        continue;
      }
      if (connection.type !== "s3") {
        await fail(`Watch requires an s3 connection (got "${connection.type}").`);
        continue;
      }
      if (connection.ownerType === "user" && connection.ownerId !== trigger.userId) {
        await fail("Watch connection is not owned by the trigger's user.");
        continue;
      }
      const connConfig = connection.config as Record<string, unknown>;
      const bucket = typeof connConfig["bucket"] === "string" ? connConfig["bucket"] : undefined;
      if (!bucket) {
        await fail("Watch connection config carries no bucket.");
        continue;
      }
      if (!connection.secretRef) {
        await fail("Watch connection has no stored credentials.");
        continue;
      }
      const credentials = parseS3ConnectionSecret(await deps.secrets.reveal(connection.secretRef));

      // ---- Filename pattern gate (literal-safe, like filter "matches") ----
      let patternRe: RegExp | undefined;
      if (config.pattern !== null && config.pattern !== undefined) {
        if (!isSafeMatchPattern(config.pattern)) {
          await fail("Watch pattern is not a safe (linear-time) pattern.");
          continue;
        }
        try {
          patternRe = new RegExp(config.pattern);
        } catch {
          await fail("Watch pattern is not a valid regular expression.");
          continue;
        }
      }

      // ---- List + filter ----------------------------------------------------
      const prefix = joinPrefix(
        typeof connConfig["prefix"] === "string" ? connConfig["prefix"] : undefined,
        config.prefix ?? "",
      );
      const listed = await list({
        ...(typeof connConfig["endpoint"] === "string" ? { endpoint: connConfig["endpoint"] } : {}),
        ...(typeof connConfig["region"] === "string" ? { region: connConfig["region"] } : {}),
        credentials,
        bucket,
        prefix,
        maxKeys: WATCH_MAX_TRACKED_OBJECTS + 1,
      });
      if (listed.length > WATCH_MAX_TRACKED_OBJECTS) {
        await fail(
          `Watched prefix holds more than ${WATCH_MAX_TRACKED_OBJECTS} objects — watch a narrower prefix.`,
        );
        continue;
      }
      const matched = patternRe
        ? listed.filter((o) => patternRe.test(basename(o.key)))
        : listed;

      // ---- Baseline first sweep (no event storm) ----------------------------
      const known: Record<string, string> | null =
        cursor !== null ? cursor.objects : config.includeExisting === true ? {} : null;
      if (known === null) {
        const baseline: WatchCursor = {
          v: 1,
          polledAt: now,
          objects: Object.fromEntries(matched.map((o) => [o.key, o.etag])),
        };
        await deps.triggers.updateCursor(trigger.id, JSON.stringify(baseline));
        summary.skipped += 1;
        continue;
      }

      // ---- Diff (created / updated; deletions leave silently) ---------------
      const changes: DetectedChange[] = [];
      for (const object of matched) {
        const knownEtag = known[object.key];
        if (knownEtag === undefined) {
          changes.push({ object, eventName: "object_created" });
        } else if (knownEtag !== object.etag) {
          changes.push({ object, eventName: "object_updated" });
        }
      }
      // Deterministic order: oldest first, key tie-break.
      changes.sort((a, b) =>
        a.object.lastModified === b.object.lastModified
          ? a.object.key.localeCompare(b.object.key)
          : a.object.lastModified.localeCompare(b.object.lastModified),
      );
      const toDispatch = changes.slice(0, WATCH_MAX_EVENTS_PER_SWEEP);

      // ---- Advance the cursor (PERSIST BEFORE DISPATCH) ----------------------
      // baseline minus deleted keys, updated ONLY for objects about to be
      // dispatched — undispatched changes keep their old state so the next
      // sweep re-detects them (no-miss).
      const listedKeys = new Set(matched.map((o) => o.key));
      const nextObjects: Record<string, string> = {};
      for (const [key, etag] of Object.entries(known)) {
        if (listedKeys.has(key)) nextObjects[key] = etag;
      }
      for (const change of toDispatch) {
        nextObjects[change.object.key] = change.object.etag;
      }
      const nextCursor: WatchCursor = { v: 1, polledAt: now, objects: nextObjects };
      try {
        await deps.triggers.updateCursor(trigger.id, JSON.stringify(nextCursor));
      } catch (err) {
        // Cursor not advanced → do NOT dispatch (double-fire risk beats a miss).
        summary.errors.push({
          triggerId: trigger.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (toDispatch.length === 0) {
        summary.skipped += 1;
        continue;
      }

      // ---- Dispatch through the FULL gate chain ------------------------------
      const consumeOne = async (name: string, payload: unknown): Promise<void> => {
        const log = await consumeTriggerEvent(trigger, { name, payload, receivedAt: now }, deps);
        if (log.outcome === "run_created") summary.dispatched += 1;
        else if (log.outcome === "error") {
          summary.errors.push({ triggerId: trigger.id, error: log.detail ?? "Fire errored." });
        } else summary.skipped += 1;
      };

      if (config.batchMode === "per_batch") {
        // One event for the whole detected batch (metadata only — S1).
        await consumeOne("objects_changed", {
          eventName: "objects_changed",
          count: toDispatch.length,
          objects: toDispatch.map((c) => ({
            key: c.object.key,
            size: c.object.size,
            etag: c.object.etag,
            lastModified: c.object.lastModified,
            eventName: c.eventName,
          })),
        });
      } else {
        for (const change of toDispatch) {
          await consumeOne(change.eventName, {
            key: change.object.key,
            size: change.object.size,
            etag: change.object.etag,
            lastModified: change.object.lastModified,
            eventName: change.eventName,
          });
        }
      }
    } catch (err) {
      await fail(err instanceof Error ? err.message : String(err));
    }
  }

  return summary;
}
