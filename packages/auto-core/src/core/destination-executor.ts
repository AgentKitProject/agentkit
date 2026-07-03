/**
 * Post-run destination executor (event-driven expansion) — runs in the WORKER
 * HARNESS after a trigger-fired run reaches a terminal status, delivering the
 * run's summary and/or PERSISTED output files to the trigger's destinations[].
 *
 * INVARIANT S2 (absolute): the AGENT never touches connection credentials.
 * This module executes OUTSIDE the agent loop; SecretStore.reveal happens only
 * here (and in app servers). Nothing revealed is ever written back onto the
 * run record, the audit log, or any response.
 *
 * SAFETY: best-effort, per-destination isolation — every outcome is audited on
 * the run (`tool: "destination"`), and NOTHING here can fail the run: the
 * top-level executeDestinations never throws.
 *
 * Destination types:
 *   - email          → the injected EmailSender (text-only today, so output
 *                      files are delivered as presigned GET LINKS, max 3).
 *   - webhook_out    → the existing signed-webhook semantics (same SSRF guard,
 *                      10s timeout, 64 KiB body: summary + presigned links).
 *   - slack_incoming → Slack-format `{ text }` POST (SSRF-guarded like
 *                      webhook_out; https-only).
 *   - connection     → s3: server-side copy of persisted outputs into the
 *                      connection's bucket/prefix using SecretStore-revealed
 *                      creds (bounded by the run-output caps);
 *                      gdrive/dropbox: provider-API uploads with the stored
 *                      OAuth token (refresh-once on expiry/401);
 *                      email/webhook_out/slack_incoming connections reuse the
 *                      inline channel with the connection's config.
 */

import type {
  AutoRunOutputFile,
  AutoRun,
  Destination,
} from "./types.js";
import type {
  AutoRunRepository,
  ConnectionRepository,
  EmailSender,
  OutputStore,
  SecretStore,
} from "./ports.js";
import type { Connection } from "./types.js";
import type { DnsResolver, FetchFn } from "./http-fetch.js";
import {
  assertWebhookDestinationSafe,
  buildWebhookPayload,
  signWebhookBody,
  type DeliveryResultInput,
} from "./delivery.js";
import {
  RUN_OUTPUT_FILE_MAX_BYTES,
  RUN_OUTPUT_MAX_FILES,
  RUN_OUTPUT_TOTAL_MAX_BYTES,
} from "./run-output-persist.js";
import {
  ensureFreshOAuthToken,
  isOAuthProvider,
  type OAuthProvidersConfig,
} from "./oauth-connections.js";

/** Max output-file LINKS included in an email destination body. */
export const DESTINATION_EMAIL_MAX_LINKS = 3;

/** Webhook/slack POST timeout (ms) — mirrors Phase D delivery. */
export const DESTINATION_WEBHOOK_TIMEOUT_MS = 10_000;

/** Max webhook/slack request-body bytes — mirrors Phase D delivery. */
export const DESTINATION_MAX_BODY_BYTES = 64 * 1024;

/** Max output chars in a destination summary — mirrors Phase D delivery. */
export const DESTINATION_MAX_OUTPUT_CHARS = 4000;

/** One executed destination's outcome (also audited on the run). */
export interface DestinationOutcome {
  /** Index into the trigger's destinations[]. */
  index: number;
  type: Destination["type"];
  status: "delivered" | "failed" | "skipped";
  /** Failure / skip detail (absent on a clean delivery). */
  error?: string;
}

/** Server-side S3 PUT seam (destination copies). Injectable for tests; the
 *  default lazy-imports @aws-sdk/client-s3 and builds a client per call. */
export type S3PutObjectFn = (args: {
  endpoint?: string;
  region?: string;
  forcePathStyle?: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
  bucket: string;
  key: string;
  body: Uint8Array;
}) => Promise<void>;

async function defaultS3Put(args: Parameters<S3PutObjectFn>[0]): Promise<void> {
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: args.region ?? "us-east-1",
    ...(args.endpoint ? { endpoint: args.endpoint, forcePathStyle: args.forcePathStyle ?? true } : {}),
    credentials: args.credentials,
  });
  try {
    await client.send(new PutObjectCommand({ Bucket: args.bucket, Key: args.key, Body: args.body }));
  } finally {
    client.destroy();
  }
}

export interface DestinationExecutorDeps {
  /** Audit sink (appendAudit) — outcomes are logged per destination. */
  runs: AutoRunRepository;
  /** Connection records ("connection"-type destinations). */
  connections?: ConnectionRepository;
  /** Credential store (S2: revealed ONLY here / app servers). */
  secrets?: SecretStore;
  /** Persisted-output byte/URL source (links + copies). */
  outputStore?: OutputStore;
  /** Email channel (provider-specific; absent → email destinations skip). */
  emailSender?: EmailSender;
  /** Injected fetch (webhook/slack/provider uploads + output GET fallback). */
  fetchImpl?: FetchFn;
  /** Injected DNS resolver (SSRF guard). */
  resolver?: DnsResolver;
  /** OAuth provider app credentials (gdrive/dropbox refresh). */
  oauth?: OAuthProvidersConfig;
  /** Server-side S3 PUT (s3-connection copies). Defaults to a real client. */
  s3Put?: S3PutObjectFn;
}

export interface ExecuteDestinationsArgs {
  run: AutoRun;
  destinations: Destination[];
  result: DeliveryResultInput;
  /** The persisted-output manifest ([] = links/copies are skipped). */
  outputFiles: AutoRunOutputFile[];
  deps: DestinationExecutorDeps;
  /** Clock — ISO 8601. Injected; never an argless Date. */
  now: () => string;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated]`;
}

function kitRefLabel(run: AutoRun): string {
  const ref = run.kitRef;
  if (ref.source === "market") return ref.slug ?? ref.marketKitId ?? "market-kit";
  return ref.localKitId ?? "local-kit";
}

/** Presignable manifest entries (persisted with a storeKey). */
function presignable(outputFiles: AutoRunOutputFile[]): AutoRunOutputFile[] {
  return outputFiles.filter(
    (f): f is AutoRunOutputFile & { storeKey: string } =>
      typeof f.storeKey === "string" && f.storeKey.length > 0,
  );
}

/** Presigned links for up to `max` persisted outputs (best-effort per file). */
async function presignLinks(
  outputFiles: AutoRunOutputFile[],
  outputStore: OutputStore | undefined,
  max: number,
): Promise<{ path: string; url: string }[]> {
  if (!outputStore) return [];
  const links: { path: string; url: string }[] = [];
  for (const f of presignable(outputFiles).slice(0, max)) {
    try {
      links.push({ path: f.path, url: await outputStore.presignGet(f.storeKey as string) });
    } catch {
      /* best-effort — a link that can't be minted is dropped */
    }
  }
  return links;
}

/** Reads one persisted output's bytes (getRunOutput, else presign + fetch). */
async function readOutputBytes(
  storeKey: string,
  outputStore: OutputStore,
  fetchImpl: FetchFn | undefined,
): Promise<Uint8Array> {
  if (outputStore.getRunOutput) {
    return outputStore.getRunOutput(storeKey);
  }
  if (!fetchImpl) {
    throw new Error("No byte reader available (no getRunOutput and no fetch).");
  }
  const url = await outputStore.presignGet(storeKey);
  const res = await fetchImpl(url, { method: "GET" });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Output fetch responded with HTTP ${res.status}.`);
  }
  return Buffer.from(await res.text(), "utf8");
}

interface ChannelResult {
  status: "delivered" | "failed" | "skipped";
  error?: string;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

async function sendEmailDestination(
  args: ExecuteDestinationsArgs,
  to: string[],
): Promise<ChannelResult> {
  const { run, result, deps, outputFiles } = args;
  if (!deps.emailSender) {
    return { status: "skipped", error: "Email delivery is unavailable (no EmailSender wired)." };
  }
  if (to.length === 0) return { status: "skipped", error: "No recipients." };
  const kit = kitRefLabel(run);
  const links = await presignLinks(outputFiles, deps.outputStore, DESTINATION_EMAIL_MAX_LINKS);
  const linkBlock =
    links.length > 0
      ? `\nOutput files (links expire):\n${links.map((l) => `  - ${l.path}: ${l.url}`).join("\n")}\n`
      : "";
  const text =
    `Run ${run.id} (${kit}) finished: ${result.status}.\n\n` +
    `Output:\n${truncate(result.output ?? "", DESTINATION_MAX_OUTPUT_CHARS)}\n` +
    linkBlock;
  const subject = `[AgentKitAuto] ${kit} run ${result.status}`;
  try {
    return await deps.emailSender.sendEmail({ to, subject, text });
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

async function postGuardedJson(
  deps: DestinationExecutorDeps,
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<ChannelResult> {
  const { fetchImpl, resolver } = deps;
  if (!fetchImpl || !resolver) {
    return { status: "failed", error: "Delivery is unavailable (no fetch/resolver wired)." };
  }
  try {
    await assertWebhookDestinationSafe(url, resolver);
    if (Buffer.byteLength(body, "utf8") > DESTINATION_MAX_BODY_BYTES) {
      return {
        status: "failed",
        error: `Payload exceeds the ${DESTINATION_MAX_BODY_BYTES}-byte cap.`,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DESTINATION_WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "AgentKitAuto-Delivery/1", ...headers },
        body,
        signal: controller.signal,
      });
      if (res.status >= 200 && res.status < 300) return { status: "delivered" };
      return { status: "failed", error: `Destination responded with HTTP ${res.status}.` };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendWebhookDestination(
  args: ExecuteDestinationsArgs,
  url: string,
  secret: string | null | undefined,
): Promise<ChannelResult> {
  const { run, result, deps, outputFiles, now } = args;
  const finishedAt = run.finishedAt ?? now();
  const links = await presignLinks(
    outputFiles,
    deps.outputStore,
    presignable(outputFiles).length,
  );
  const payload = {
    ...buildWebhookPayload(run, result, finishedAt, DESTINATION_MAX_OUTPUT_CHARS),
    /** Presigned output links (empty when no outputs were persisted). */
    outputLinks: links,
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "X-AutoDelivery-Signature": secret ? signWebhookBody(body, secret) : "none",
  };
  return postGuardedJson(deps, url, body, headers);
}

async function sendSlackDestination(
  args: ExecuteDestinationsArgs,
  url: string,
): Promise<ChannelResult> {
  const { run, result, deps, outputFiles } = args;
  const kit = kitRefLabel(run);
  const links = await presignLinks(outputFiles, deps.outputStore, DESTINATION_EMAIL_MAX_LINKS);
  const linkLines = links.map((l) => `• <${l.url}|${l.path}>`).join("\n");
  const text =
    `*[AgentKitAuto]* ${kit} run *${result.status}* (run ${run.id})\n` +
    `${truncate(result.output ?? "", 1000)}` +
    (linkLines ? `\n${linkLines}` : "");
  return postGuardedJson(deps, url, JSON.stringify({ text }), {});
}

// ---------------------------------------------------------------------------
// Connection-backed destinations
// ---------------------------------------------------------------------------

/** Parses S3 connection credentials from the revealed secret: JSON
 *  {accessKeyId, secretAccessKey} or the compact "accessKeyId:secretAccessKey". */
export function parseS3ConnectionSecret(plaintext: string): {
  accessKeyId: string;
  secretAccessKey: string;
} {
  try {
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    if (
      typeof parsed["accessKeyId"] === "string" &&
      typeof parsed["secretAccessKey"] === "string"
    ) {
      return {
        accessKeyId: parsed["accessKeyId"],
        secretAccessKey: parsed["secretAccessKey"],
      };
    }
  } catch {
    /* fall through to the compact form */
  }
  const idx = plaintext.indexOf(":");
  if (idx > 0 && idx < plaintext.length - 1) {
    return { accessKeyId: plaintext.slice(0, idx), secretAccessKey: plaintext.slice(idx + 1) };
  }
  throw new Error(
    'S3 connection secret must be JSON {"accessKeyId","secretAccessKey"} or "accessKeyId:secretAccessKey".',
  );
}

function joinPrefix(prefix: string | undefined, path: string): string {
  const p = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  return p.length > 0 ? `${p}/${path}` : path;
}

/** Copies persisted outputs into the connection's S3 bucket/prefix — bounded
 *  by the SAME caps as output persistence. */
async function copyOutputsToS3Connection(
  args: ExecuteDestinationsArgs,
  connection: Connection,
  destinationPath: string | undefined,
): Promise<ChannelResult> {
  const { deps, outputFiles } = args;
  if (!deps.secrets) return { status: "failed", error: "No SecretStore wired." };
  if (!deps.outputStore) {
    return { status: "skipped", error: "No persisted outputs (OutputStore unconfigured)." };
  }
  const files = presignable(outputFiles);
  if (files.length === 0) return { status: "skipped", error: "No persisted output files." };

  const config = connection.config as Record<string, unknown>;
  const bucket = typeof config["bucket"] === "string" ? config["bucket"] : undefined;
  if (!bucket) return { status: "failed", error: "Connection config carries no bucket." };
  if (!connection.secretRef) {
    return { status: "failed", error: "Connection has no stored credentials." };
  }

  let credentials: { accessKeyId: string; secretAccessKey: string };
  try {
    credentials = parseS3ConnectionSecret(await deps.secrets.reveal(connection.secretRef));
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  const put = deps.s3Put ?? defaultS3Put;
  const basePrefix =
    destinationPath ?? (typeof config["prefix"] === "string" ? config["prefix"] : undefined);
  let totalBytes = 0;
  let copied = 0;
  const failures: string[] = [];
  for (const f of files.slice(0, RUN_OUTPUT_MAX_FILES)) {
    if (f.sizeBytes > RUN_OUTPUT_FILE_MAX_BYTES) continue; // persisted files already respect this
    if (totalBytes + f.sizeBytes > RUN_OUTPUT_TOTAL_MAX_BYTES) break;
    try {
      const bytes = await readOutputBytes(f.storeKey as string, deps.outputStore, deps.fetchImpl);
      await put({
        ...(typeof config["endpoint"] === "string" ? { endpoint: config["endpoint"] } : {}),
        ...(typeof config["region"] === "string" ? { region: config["region"] } : {}),
        credentials,
        bucket,
        key: joinPrefix(basePrefix, f.path),
        body: bytes,
      });
      totalBytes += f.sizeBytes;
      copied += 1;
    } catch (err) {
      failures.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (copied === 0 && failures.length > 0) {
    return { status: "failed", error: `No files copied — ${failures[0]}` };
  }
  if (failures.length > 0) {
    return { status: "delivered", error: `Copied ${copied}; failed: ${failures.join("; ")}` };
  }
  return { status: "delivered" };
}

/** Uploads one file to Google Drive (multipart; folder id from config). */
async function uploadToDrive(
  fetchImpl: FetchFn,
  accessToken: string,
  folderId: string | undefined,
  name: string,
  content: Uint8Array,
): Promise<number> {
  const boundary = "agentkitauto-multipart";
  const metadata = JSON.stringify({
    name,
    ...(folderId ? { parents: [folderId] } : {}),
  });
  const body =
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n${Buffer.from(content).toString("utf8")}\r\n` +
    `--${boundary}--`;
  const res = await fetchImpl(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  return res.status;
}

/** Uploads one file to Dropbox (/2/files/upload; path prefix from config). */
async function uploadToDropbox(
  fetchImpl: FetchFn,
  accessToken: string,
  prefix: string | undefined,
  name: string,
  content: Uint8Array,
): Promise<number> {
  const path = `/${joinPrefix(prefix, name)}`;
  const res = await fetchImpl("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", mute: true }),
    },
    body: Buffer.from(content).toString("utf8"),
  });
  return res.status;
}

/** Delivers persisted outputs through an OAuth provider connection
 *  (gdrive/dropbox). Refreshes the token once on expiry/401 and retries. */
async function copyOutputsToOAuthConnection(
  args: ExecuteDestinationsArgs,
  connection: Connection,
  destinationPath: string | undefined,
): Promise<ChannelResult> {
  const { deps, outputFiles, now } = args;
  const provider = connection.type;
  if (!isOAuthProvider(provider)) {
    return { status: "failed", error: `Unsupported provider "${provider}".` };
  }
  const config = deps.oauth?.[provider];
  if (!config) {
    return {
      status: "failed",
      error: `${provider} is not configured on this instance (no OAuth app credentials).`,
    };
  }
  if (!deps.secrets || !deps.connections || !deps.fetchImpl) {
    return { status: "failed", error: "No SecretStore/ConnectionRepository/fetch wired." };
  }
  if (!deps.outputStore) {
    return { status: "skipped", error: "No persisted outputs (OutputStore unconfigured)." };
  }
  const files = presignable(outputFiles);
  if (files.length === 0) return { status: "skipped", error: "No persisted output files." };

  const connConfig = connection.config as Record<string, unknown>;
  const folderId = typeof connConfig["folderId"] === "string" ? connConfig["folderId"] : undefined;
  const prefix =
    destinationPath ?? (typeof connConfig["prefix"] === "string" ? connConfig["prefix"] : undefined);

  const fresh = async (): Promise<string> =>
    ensureFreshOAuthToken({
      connection: (await deps.connections!.getConnection(connection.id)) ?? connection,
      provider,
      config,
      secrets: deps.secrets!,
      connections: deps.connections!,
      fetchImpl: deps.fetchImpl!,
      now,
    });

  let accessToken: string;
  try {
    accessToken = await fresh();
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  let totalBytes = 0;
  const failures: string[] = [];
  let uploaded = 0;
  let refreshedOnce = false;
  for (const f of files.slice(0, RUN_OUTPUT_MAX_FILES)) {
    if (totalBytes + f.sizeBytes > RUN_OUTPUT_TOTAL_MAX_BYTES) break;
    try {
      const bytes = await readOutputBytes(f.storeKey as string, deps.outputStore, deps.fetchImpl);
      const doUpload = async (token: string): Promise<number> =>
        provider === "gdrive"
          ? uploadToDrive(deps.fetchImpl!, token, folderId, f.path, bytes)
          : uploadToDropbox(deps.fetchImpl!, token, prefix, f.path, bytes);
      let status = await doUpload(accessToken);
      if (status === 401 && !refreshedOnce) {
        // Expired mid-batch (or the stored expiry was stale) → refresh + retry ONCE.
        refreshedOnce = true;
        accessToken = await fresh();
        status = await doUpload(accessToken);
      }
      if (status >= 200 && status < 300) uploaded += 1;
      else failures.push(`${f.path}: HTTP ${status}`);
      totalBytes += f.sizeBytes;
    } catch (err) {
      failures.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (uploaded === 0 && failures.length > 0) {
    return { status: "failed", error: `No files uploaded — ${failures[0]}` };
  }
  if (failures.length > 0) {
    return { status: "delivered", error: `Uploaded ${uploaded}; failed: ${failures.join("; ")}` };
  }
  return { status: "delivered" };
}

async function executeConnectionDestination(
  args: ExecuteDestinationsArgs,
  destination: Extract<Destination, { type: "connection" }>,
): Promise<ChannelResult> {
  const { run, deps } = args;
  if (!deps.connections) {
    return { status: "failed", error: "Connections are unavailable (no repository wired)." };
  }
  const connection = await deps.connections.getConnection(destination.connectionId);
  if (!connection) return { status: "failed", error: "Connection not found." };
  // Ownership: a trigger can only deliver through its OWNER's connections.
  if (connection.ownerType === "user" && connection.ownerId !== run.userId) {
    return { status: "failed", error: "Connection is not owned by the run's user." };
  }

  const what = destination.what ?? "both";

  switch (connection.type) {
    case "s3":
      return copyOutputsToS3Connection(args, connection, destination.path);
    case "gdrive":
    case "dropbox":
      return copyOutputsToOAuthConnection(args, connection, destination.path);
    case "email": {
      if (what === "outputs") {
        // Email cannot carry raw outputs; links are part of the summary body.
        return { status: "skipped", error: 'Email connections deliver summaries (use what: "both").' };
      }
      const config = connection.config as Record<string, unknown>;
      const to = Array.isArray(config["to"])
        ? (config["to"] as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      return sendEmailDestination(args, to);
    }
    case "webhook_out": {
      const config = connection.config as Record<string, unknown>;
      const url = typeof config["url"] === "string" ? config["url"] : undefined;
      if (!url) return { status: "failed", error: "Connection config carries no url." };
      const secret = connection.secretRef && deps.secrets ? await deps.secrets.reveal(connection.secretRef).catch(() => undefined) : undefined;
      return sendWebhookDestination(args, url, secret ?? null);
    }
    case "slack_incoming": {
      const config = connection.config as Record<string, unknown>;
      const url = typeof config["url"] === "string" ? config["url"] : undefined;
      if (!url) return { status: "failed", error: "Connection config carries no url." };
      return sendSlackDestination(args, url);
    }
    default:
      return { status: "failed", error: `Unsupported connection type "${connection.type}".` };
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Executes every destination of a terminal trigger-fired run. BEST-EFFORT and
 * per-destination isolated: each outcome is audited on the run; the function
 * NEVER throws (a destination failure must not fail the run). Legacy
 * deliveryConfig delivery is untouched — this runs IN ADDITION when the run's
 * trigger carries destinations[].
 */
export async function executeDestinations(
  args: ExecuteDestinationsArgs,
): Promise<DestinationOutcome[]> {
  const { run, destinations, deps, now } = args;
  const outcomes: DestinationOutcome[] = [];

  for (let index = 0; index < destinations.length; index++) {
    const destination = destinations[index]!;
    let result: ChannelResult;
    try {
      switch (destination.type) {
        case "email":
          result = await sendEmailDestination(args, destination.to);
          break;
        case "webhook_out":
          result = await sendWebhookDestination(args, destination.url, destination.secret);
          break;
        case "slack_incoming":
          result = await sendSlackDestination(args, destination.url);
          break;
        case "connection":
          result = await executeConnectionDestination(args, destination);
          break;
        default:
          result = { status: "failed", error: "Unknown destination type." };
      }
    } catch (err) {
      // Defensive: channel impls are contracted not to throw, but never let a
      // destination hiccup escape the executor.
      result = { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }

    const outcome: DestinationOutcome = {
      index,
      type: destination.type,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    };
    outcomes.push(outcome);

    await deps.runs
      .appendAudit(run.id, {
        tool: "destination",
        argsSummary: `type=${destination.type} index=${index}`,
        outcome:
          result.status === "delivered" ? "ok" : result.status === "skipped" ? "rejected" : "error",
        ts: now(),
        ...(result.error ? { detail: result.error } : {}),
      })
      .catch(() => {});
  }

  return outcomes;
}
