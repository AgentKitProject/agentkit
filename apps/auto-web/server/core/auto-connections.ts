// AgentKitAuto — Connections CRUD + verify probe + persisted-output downloads
// (Wave 3a APPS layer).
//
// Connections are REUSABLE delivery targets (S3 bucket, outbound webhook, Slack
// incoming webhook, email recipients, Drive/Dropbox via OAuth) referenced by
// trigger destinations[]. This module wires storage + validation around the
// auto-core mechanism; the destination EXECUTION lives in auto-core's
// destination-executor (worker harness), not here.
//
// S2 (absolute): credential plaintext travels ONLY through the SecretStore —
// the write-only `secret` request field is moved straight into events.secrets
// (→ opaque secretRef) and is NEVER echoed in any response or persisted record.
// The verify probe reveals credentials SERVER-SIDE only (never to the browser,
// never onto the connection record).
//
// AUTH NOTE: auth-agnostic, exactly like server/core/auto-events.ts — the
// cookie routes (/api/auto/connections*) and the bearer routes
// (/api/forge/auto/connections*) both resolve `userId` with their own helper
// and call these userId-keyed functions.
//
// MIRROR of apps/forge/server/core/auto-connections.ts (keep in lockstep; the
// OAuth browser flow is auto-web-only and lives in server/core/auto-oauth.ts).

import {
  assertWebhookDestinationSafe,
  parseS3ConnectionSecret,
  SecretStoreUnconfiguredError,
  type Connection,
  type DnsResolver,
} from "@agentkitforge/auto-core";
import {
  createConnectionRequestSchema,
  updateConnectionRequestSchema,
} from "@agentkitforge/contracts";
import { AutoValidationError, getAutoStorage } from "@/server/core/auto";
import { getEventStorage } from "@/server/core/auto-events";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * A connection type that cannot be created via direct POST: gdrive/dropbox go
 * through the OAuth flow; imap is not implemented yet. Routes map this to 501.
 */
export class ConnectionNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionNotImplementedError";
  }
}

/** Maps ConnectionNotImplementedError → 501 (routes chain this in front of
 *  autoEventErrorResponse so validation/approval mapping stays shared). */
export function connectionErrorResponse(error: unknown): Response | null {
  if (error instanceof ConnectionNotImplementedError) {
    return Response.json(
      { error: "not_implemented", message: error.message },
      { status: 501 },
    );
  }
  return null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function zodMessage(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

/**
 * Stores WRITE-ONLY connection credential plaintext in the SecretStore and
 * returns the opaque ref. Unset AUTO_SECRET_ENCRYPTION_KEY → a clear 400
 * (mirrors storeSigningSecret in auto-events.ts).
 */
async function storeConnectionSecret(plaintext: string): Promise<string> {
  const events = await getEventStorage();
  try {
    return await events.secrets.put(plaintext);
  } catch (err) {
    if (err instanceof SecretStoreUnconfiguredError || (err as Error)?.name === "SecretStoreUnconfiguredError") {
      throw new AutoValidationError(
        "Secret storage is not configured on this instance (set AUTO_SECRET_ENCRYPTION_KEY).",
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Create a connection. Directly creatable types: s3 / email / webhook_out /
 * slack_incoming, plus the Wave 4 bot types (slack_bot / telegram_bot /
 * discord_bot — `secret` REQUIRED: it is the bot token, SecretStore-only, S2).
 * gdrive/dropbox → 501 (use the OAuth flow); imap → 501 (coming soon). A
 * write-only `secret` is moved into the SecretStore; only the opaque
 * secretRef lands on the record.
 */
export async function createConnection(userId: string, body: unknown): Promise<Connection> {
  const parsed = createConnectionRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new AutoValidationError(`Invalid connection: ${zodMessage(parsed.error)}`);
  }
  const request = parsed.data;
  if (request.ownerType === "org") {
    throw new AutoValidationError("Org-owned connections are not supported yet.");
  }
  if (request.type === "gdrive" || request.type === "dropbox") {
    throw new ConnectionNotImplementedError(
      `Direct create is not supported for "${request.type}" connections — use the OAuth flow.`,
    );
  }
  if (request.type === "imap") {
    throw new ConnectionNotImplementedError("imap connections are coming soon.");
  }
  if (
    (request.type === "slack_bot" || request.type === "telegram_bot" || request.type === "discord_bot") &&
    request.secret === undefined
  ) {
    throw new AutoValidationError(
      `"${request.type}" connections require \`secret\` (the bot token — stored encrypted, never echoed).`,
    );
  }
  const secretRef = request.secret !== undefined ? await storeConnectionSecret(request.secret) : null;
  const events = await getEventStorage();
  return events.connections.createConnection({
    ownerType: "user",
    ownerId: userId,
    name: request.name,
    type: request.type,
    config: request.config,
    secretRef,
    createdAt: nowIso(),
  });
}

/** List the user's connections (secretRef is an opaque handle — never plaintext). */
export async function listConnections(userId: string): Promise<Connection[]> {
  const events = await getEventStorage();
  return events.connections.listConnectionsByOwner("user", userId);
}

/** Get one connection, ownership-checked. Null for missing/cross-user (→ 404). */
export async function getConnection(userId: string, connectionId: string): Promise<Connection | null> {
  const events = await getEventStorage();
  const connection = await events.connections.getConnection(connectionId);
  if (!connection || connection.ownerType !== "user" || connection.ownerId !== userId) return null;
  return connection;
}

/**
 * Patch name/config (+ WRITE-ONLY secret rotation), ownership-checked. A new
 * secret is stored encrypted and the superseded ref is deleted best-effort;
 * plaintext is never echoed. Null → 404.
 */
export async function updateConnection(
  userId: string,
  connectionId: string,
  body: unknown,
): Promise<Connection | null> {
  const current = await getConnection(userId, connectionId);
  if (!current) return null;
  const parsed = updateConnectionRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new AutoValidationError(`Invalid connection patch: ${zodMessage(parsed.error)}`);
  }
  const { secret, ...patch } = parsed.data;
  let secretRef: string | undefined;
  const previousRef = current.secretRef ?? undefined;
  if (secret !== undefined) {
    secretRef = await storeConnectionSecret(secret);
  }
  const events = await getEventStorage();
  const updated = await events.connections.updateConnection(connectionId, {
    ...patch,
    ...(secretRef !== undefined ? { secretRef } : {}),
  });
  // Replace semantics: drop the superseded secret (best-effort — an orphaned
  // ciphertext row is harmless; a missing new ref would not be).
  if (previousRef !== undefined && secretRef !== undefined) {
    try {
      await events.secrets.delete(previousRef);
    } catch {
      /* best-effort */
    }
  }
  return updated ?? null;
}

/** Delete a connection, ownership-checked (its stored credential is deleted
 *  best-effort too). False → 404. */
export async function deleteConnection(userId: string, connectionId: string): Promise<boolean> {
  const connection = await getConnection(userId, connectionId);
  if (!connection) return false;
  const events = await getEventStorage();
  if (connection.secretRef) {
    try {
      await events.secrets.delete(connection.secretRef);
    } catch {
      /* best-effort — an orphaned ciphertext row is harmless */
    }
  }
  await events.connections.deleteConnection(connectionId);
  return true;
}

// ---------------------------------------------------------------------------
// Verify probe
// ---------------------------------------------------------------------------

/** Server-side S3 list probe seam (max 1 key). Injectable for tests; the
 *  default lazy-imports @aws-sdk/client-s3 and builds a client per call, the
 *  SAME way auto-core's s3-output-store / destination-executor do. */
export type S3ListProbeFn = (args: {
  endpoint?: string;
  region?: string;
  forcePathStyle?: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
  bucket: string;
  prefix?: string;
}) => Promise<void>;

async function defaultS3ListProbe(args: Parameters<S3ListProbeFn>[0]): Promise<void> {
  const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: args.region ?? "us-east-1",
    ...(args.endpoint ? { endpoint: args.endpoint, forcePathStyle: args.forcePathStyle ?? true } : {}),
    credentials: args.credentials,
  });
  try {
    await client.send(
      new ListObjectsV2Command({
        Bucket: args.bucket,
        MaxKeys: 1,
        ...(args.prefix ? { Prefix: args.prefix } : {}),
      }),
    );
  } finally {
    client.destroy();
  }
}

/** Real DNS resolver for the webhook SSRF guard (A + AAAA), mirroring
 *  auto-core's run-task resolver. */
async function defaultDnsResolver(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

interface VerifyOverrides {
  s3List?: S3ListProbeFn;
  resolver?: DnsResolver;
}

let verifyOverrides: VerifyOverrides = {};

/** Test seam: inject the S3 probe / DNS resolver (offline tests). */
export function setConnectionVerifyOverridesForTests(overrides: VerifyOverrides): void {
  verifyOverrides = overrides;
}

/** Cheap RFC-lite email shape check (format probe only — nothing is sent). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmailList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && EMAIL_RE.test(v))
  );
}

/** One verify-probe outcome: the (re-read) connection + the failure detail. */
export interface VerifyConnectionResult {
  connection: Connection;
  error?: string;
}

/**
 * Verify a connection with a cheap, side-effect-free probe:
 *   - s3             → ListObjectsV2 (max 1 key) with SecretStore-revealed creds.
 *   - webhook_out /
 *     slack_incoming → https + SSRF-guard resolve (NO request is sent).
 *   - email          → recipient format check.
 *   - *_bot          → stored-token presence check (no live API call).
 * Stamps connection.status ok|error and returns the updated connection.
 * gdrive/dropbox/imap probes are not supported (→ 400). Null → 404.
 */
export async function verifyConnection(
  userId: string,
  connectionId: string,
): Promise<VerifyConnectionResult | null> {
  const connection = await getConnection(userId, connectionId);
  if (!connection) return null;
  const events = await getEventStorage();
  const config = connection.config as Record<string, unknown>;

  let error: string | undefined;
  switch (connection.type) {
    case "s3": {
      const bucket = typeof config["bucket"] === "string" ? config["bucket"] : undefined;
      if (!bucket) {
        error = "Connection config carries no bucket.";
        break;
      }
      if (!connection.secretRef) {
        error = "Connection has no stored credentials.";
        break;
      }
      try {
        const credentials = parseS3ConnectionSecret(await events.secrets.reveal(connection.secretRef));
        const probe = verifyOverrides.s3List ?? defaultS3ListProbe;
        await probe({
          ...(typeof config["endpoint"] === "string" ? { endpoint: config["endpoint"] } : {}),
          ...(typeof config["region"] === "string" ? { region: config["region"] } : {}),
          credentials,
          bucket,
          ...(typeof config["prefix"] === "string" ? { prefix: config["prefix"] } : {}),
        });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      break;
    }
    case "webhook_out":
    case "slack_incoming": {
      const url = typeof config["url"] === "string" ? config["url"] : undefined;
      if (!url) {
        error = "Connection config carries no url.";
        break;
      }
      try {
        // https-only + private-IP rejection; the guard resolves but NEVER posts.
        await assertWebhookDestinationSafe(url, verifyOverrides.resolver ?? defaultDnsResolver);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      break;
    }
    case "email": {
      if (!isValidEmailList(config["to"])) {
        error = "Connection config.to must be a non-empty list of valid email addresses.";
      }
      break;
    }
    case "slack_bot":
    case "telegram_bot":
    case "discord_bot": {
      // Cheap, side-effect-free: a bot connection is usable iff a token is
      // stored (S2 — no live API call is made here).
      if (!connection.secretRef) {
        error = "Bot connection has no stored token.";
      }
      break;
    }
    default:
      throw new AutoValidationError(
        `Verification is not supported for "${connection.type}" connections.`,
      );
  }

  if (error === undefined) {
    await events.connections.setConnectionStatus(connectionId, "ok", nowIso());
  } else {
    await events.connections.setConnectionStatus(connectionId, "error");
  }
  const updated = (await events.connections.getConnection(connectionId)) ?? {
    ...connection,
    status: error === undefined ? ("ok" as const) : ("error" as const),
  };
  return { connection: updated, ...(error !== undefined ? { error } : {}) };
}

// ---------------------------------------------------------------------------
// Persisted-output downloads
// ---------------------------------------------------------------------------

/**
 * Presigned GET URL for one of a run's PERSISTED output files, ownership-
 * checked. Null (→ 404) when the run is missing/cross-user, the path has no
 * manifest entry (or no storeKey), the entry is past its expiresAt, or no
 * OutputStore is configured on this deployment.
 */
export async function presignRunOutput(
  userId: string,
  runId: string,
  path: string,
): Promise<string | null> {
  const storage = await getAutoStorage();
  const run = await storage.runs.getRun(runId);
  if (!run || run.userId !== userId) return null;
  const entry = (run.outputFiles ?? []).find(
    (f) => f.path === path && typeof f.storeKey === "string" && f.storeKey.length > 0,
  );
  if (!entry) return null;
  if (entry.expiresAt) {
    const expiresMs = Date.parse(entry.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) return null;
  }
  if (!storage.outputs) return null;
  try {
    return await storage.outputs.presignGet(entry.storeKey as string);
  } catch {
    return null;
  }
}
