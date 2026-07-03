// Pure helpers for the wizard's folder-watch step (kind === "watch") and its
// inline connection-create flow. Kept UI-free so they are unit-testable in the
// node vitest environment (the TriggerWizard JSX imports these).
//
// S2 stays intact: the S3 secret (access key id + secret access key) is encoded
// into the WRITE-ONLY `secret` field the connections route moves straight into
// the SecretStore — it never lands in `config` (which the contract refines to
// reject secret-looking keys). The secret string matches auto-core's
// parseS3ConnectionSecret exactly: JSON {"accessKeyId","secretAccessKey"}.

import type {
  ConnectionType,
  CreateConnectionRequest,
  TriggerMapping
} from "@agentkitforge/contracts";

/** The connection types the folder-watch step can watch (poll for new files). */
export const WATCHABLE_CONNECTION_TYPES: ConnectionType[] = ["s3", "gdrive", "dropbox"];

/** True when a connection type can be watched by a "watch" trigger. */
export function isWatchableConnectionType(type: string): boolean {
  return (WATCHABLE_CONNECTION_TYPES as string[]).includes(type);
}

/**
 * Encodes the S3 access key id + secret access key into the exact plaintext
 * `secret` string auto-core's parseS3ConnectionSecret expects: JSON with
 * `accessKeyId` and `secretAccessKey` keys. (parseS3ConnectionSecret also
 * accepts the compact "id:secret" form, but a secret access key can itself
 * contain ':' — so we always emit JSON, which is unambiguous.)
 */
export function encodeS3ConnectionSecret(accessKeyId: string, secretAccessKey: string): string {
  return JSON.stringify({ accessKeyId, secretAccessKey });
}

export interface S3ConnectFields {
  name: string;
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Builds the POST /api/auto/connections body for an inline S3 / S3-compatible
 * connection create. The non-secret config carries only bucket/region/endpoint
 * (+ forcePathStyle when an endpoint is set, so MinIO/Spaces path-style URLs
 * work); the credentials ride in the write-only `secret`.
 */
export function buildS3ConnectionRequest(fields: S3ConnectFields): CreateConnectionRequest {
  const region = fields.region?.trim();
  const endpoint = fields.endpoint?.trim();
  const config: Record<string, unknown> = { bucket: fields.bucket.trim() };
  if (region) config.region = region;
  if (endpoint) {
    config.endpoint = endpoint;
    // Custom endpoints (MinIO / DO Spaces) generally need path-style addressing.
    config.forcePathStyle = true;
  }
  return {
    type: "s3",
    name: fields.name.trim(),
    config,
    secret: encodeS3ConnectionSecret(fields.accessKeyId.trim(), fields.secretAccessKey.trim()),
    ownerType: "user"
  };
}

/** A local validation error string, or null when the S3 form is complete. */
export function validateS3ConnectFields(fields: S3ConnectFields): string | null {
  if (!fields.name.trim()) return "Name this connection.";
  if (!fields.bucket.trim()) return "Enter the S3 bucket name.";
  if (!fields.accessKeyId.trim()) return "Enter the access key id.";
  if (!fields.secretAccessKey.trim()) return "Enter the secret access key.";
  return null;
}

// ---------------------------------------------------------------------------
// Watch trigger request
// ---------------------------------------------------------------------------

export interface WatchConfigFields {
  connectionId: string;
  prefix: string;
  pattern: string;
  batchMode: "per_file" | "per_batch";
  intervalMinutes: number;
  includeExisting: boolean;
}

/** The watchTriggerConfig object (contract shape) from the wizard fields. A
 *  blank pattern is omitted (null/absent = match all). */
export function buildWatchConfig(fields: WatchConfigFields) {
  const pattern = fields.pattern.trim();
  return {
    connectionId: fields.connectionId,
    prefix: fields.prefix.trim(),
    ...(pattern ? { pattern } : {}),
    batchMode: fields.batchMode,
    intervalMinutes: Math.min(1440, Math.max(1, Math.trunc(fields.intervalMinutes) || 5)),
    includeExisting: fields.includeExisting
  };
}

// ---------------------------------------------------------------------------
// OAuth draft persistence (survives the full-page provider redirect)
// ---------------------------------------------------------------------------

/** sessionStorage key the in-progress wizard draft is stashed under before an
 *  OAuth full-page redirect, and restored from on `?connection=created`. */
export const WATCH_DRAFT_STORAGE_KEY = "auto:wizard-watch-draft";

/**
 * The minimal wizard state we re-hydrate after the OAuth round-trip. Only the
 * WHEN-step watch inputs are persisted (never any secret, never RUN/DELIVER —
 * S1: the wizard never pre-fills approvals/connections into a kit-template
 * link, and there is nothing sensitive here). `connectionId` is left blank: the
 * freshly-created OAuth connection is selected by re-fetching connections on
 * restore.
 */
export interface WatchWizardDraft {
  version: 1;
  name: string;
  prefix: string;
  pattern: string;
  batchMode: "per_file" | "per_batch";
  intervalMinutes: number;
  includeExisting: boolean;
}

export function saveWatchDraft(draft: WatchWizardDraft, storage?: Pick<Storage, "setItem">): void {
  const store = storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : undefined);
  if (!store) return;
  try {
    store.setItem(WATCH_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    /* storage full / disabled — the redirect just loses the draft, not fatal */
  }
}

/** Reads + removes the stashed draft (one-shot). Returns null when absent or
 *  malformed. */
export function takeWatchDraft(
  storage?: Pick<Storage, "getItem" | "removeItem">
): WatchWizardDraft | null {
  const store = storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : undefined);
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(WATCH_DRAFT_STORAGE_KEY);
    store.removeItem(WATCH_DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WatchWizardDraft>;
    if (parsed && parsed.version === 1 && typeof parsed.name === "string") {
      return {
        version: 1,
        name: parsed.name,
        prefix: typeof parsed.prefix === "string" ? parsed.prefix : "",
        pattern: typeof parsed.pattern === "string" ? parsed.pattern : "",
        batchMode: parsed.batchMode === "per_batch" ? "per_batch" : "per_file",
        intervalMinutes:
          typeof parsed.intervalMinutes === "number" && Number.isFinite(parsed.intervalMinutes)
            ? parsed.intervalMinutes
            : 5,
        includeExisting: parsed.includeExisting === true
      };
    }
  } catch {
    /* malformed — treat as absent */
  }
  return null;
}

/** The standard mapping every wizard-built trigger sends (S1: promptTemplate is
 *  the only instruction source; the raw payload rides along as a file when
 *  attach is on). Shared with the event/schedule submit paths. */
export function buildTriggerMapping(promptTemplate: string, attachPayload: boolean): TriggerMapping {
  return {
    promptTemplate: promptTemplate.trim(),
    attachPayloadAs: attachPayload ? "event.json" : null,
    fileHandling: "attach"
  };
}
