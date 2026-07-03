// Browser client for the Automations seam (Seam A: /api/auto/triggers +
// /api/auto/event-sources, OIDC cookie auth). Thin typed fetch wrappers over
// the contract-fixed routes in @agentkitforge/contracts (autoTriggerRoutes);
// response/request types come straight from the contracts package so the UI
// cannot drift from the server.
import {
  autoTriggerRoutes,
  type Connection,
  type CreateConnectionRequest,
  type CreateEventSourceRequest,
  type CreateEventSourceResponse,
  type CreateTriggerRequest,
  type ListConnectionsResponse,
  type ListEventSourcesResponse,
  type ListReceivedEventsResponse,
  type ListTriggerFireLogsResponse,
  type ListTriggersResponse,
  type PublicEventSource,
  type TestFireTriggerResponse,
  type Trigger,
  type UpdateEventSourceRequest,
  type UpdateTriggerRequest
} from "@agentkitforge/contracts";

/** Same cookie-path JSON fetch shape the rest of the Auto UI uses. */
async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

function post<T>(url: string, body?: unknown): Promise<T> {
  return jsonFetch<T>(url, {
    method: "POST",
    headers: JSON_HEADERS,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export async function listTriggers(): Promise<Trigger[]> {
  const { triggers } = await jsonFetch<ListTriggersResponse>(autoTriggerRoutes.triggers());
  return triggers;
}

export function createTrigger(req: CreateTriggerRequest): Promise<Trigger> {
  return post<Trigger>(autoTriggerRoutes.triggers(), req);
}

export function getTrigger(id: string): Promise<Trigger> {
  return jsonFetch<Trigger>(autoTriggerRoutes.trigger(id));
}

export function updateTrigger(id: string, patch: UpdateTriggerRequest): Promise<Trigger> {
  return jsonFetch<Trigger>(autoTriggerRoutes.trigger(id), {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch)
  });
}

export function deleteTrigger(id: string): Promise<void> {
  return jsonFetch<void>(autoTriggerRoutes.trigger(id), { method: "DELETE" });
}

/**
 * Resume a circuit-paused trigger. The update contract carries no circuit
 * field — re-asserting `enabled: true` via PATCH is the contract-shaped reset
 * (the server clears the breaker when a trigger is re-enabled).
 */
export function resumeTrigger(id: string): Promise<Trigger> {
  return updateTrigger(id, { enabled: true });
}

export function testFireTrigger(id: string, sampleEvent?: unknown): Promise<TestFireTriggerResponse> {
  return post<TestFireTriggerResponse>(
    autoTriggerRoutes.testFireTrigger(id),
    sampleEvent !== undefined ? { sampleEvent } : {}
  );
}

export async function listTriggerFireLogs(id: string) {
  const { fireLogs } = await jsonFetch<ListTriggerFireLogsResponse>(autoTriggerRoutes.triggerFireLogs(id));
  return fireLogs;
}

// ---------------------------------------------------------------------------
// Event sources
// ---------------------------------------------------------------------------

export async function listEventSources(): Promise<PublicEventSource[]> {
  const { sources } = await jsonFetch<ListEventSourcesResponse>(autoTriggerRoutes.eventSources());
  return sources;
}

/**
 * Create an event source. The response is the ONLY place the plaintext ingest
 * bearer `token` ever appears — show it once, never retrievable again.
 * `signingSecret` (provider HMAC verification, github/stripe/slack) is a
 * WRITE-ONLY extra the routes accept alongside the contract body; it is never
 * echoed back (the contract carries only `hasSigningSecret` — S2).
 */
export function createEventSource(
  req: CreateEventSourceRequest & { signingSecret?: string }
): Promise<CreateEventSourceResponse> {
  return post<CreateEventSourceResponse>(autoTriggerRoutes.eventSources(), req);
}

export function getEventSource(id: string): Promise<PublicEventSource> {
  return jsonFetch<PublicEventSource>(autoTriggerRoutes.eventSource(id));
}

export function updateEventSource(id: string, patch: UpdateEventSourceRequest): Promise<PublicEventSource> {
  return jsonFetch<PublicEventSource>(autoTriggerRoutes.eventSource(id), {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch)
  });
}

export function deleteEventSource(id: string): Promise<void> {
  return jsonFetch<void>(autoTriggerRoutes.eventSource(id), { method: "DELETE" });
}

/** POST /api/auto/event-sources/{id}/rotate-token (no contract route builder
 *  yet — path per the concurrently-built routes; response mirrors create:
 *  the fresh one-time plaintext token). */
export function rotateEventSourceToken(id: string): Promise<CreateEventSourceResponse> {
  return post<CreateEventSourceResponse>(`${autoTriggerRoutes.eventSource(id)}/rotate-token`);
}

/** Recent events on a source (inspector ring buffer), newest first. */
export async function listSourceEvents(sourceId: string) {
  const { events } = await jsonFetch<ListReceivedEventsResponse>(autoTriggerRoutes.eventSourceEvents(sourceId));
  return [...events].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
}

/** Re-fan-out a stored event to its source's triggers. */
export function replayEvent(sourceId: string, eventId: string): Promise<void> {
  return post<void>(autoTriggerRoutes.replayEvent(sourceId), { eventId });
}

// ---------------------------------------------------------------------------
// Connections (folder-watch: s3 / gdrive / dropbox). The write-only `secret`
// (S2) is moved server-side straight into the SecretStore — it is never echoed.
// ---------------------------------------------------------------------------

export async function listConnections(): Promise<Connection[]> {
  const { connections } = await jsonFetch<ListConnectionsResponse>(autoTriggerRoutes.connections());
  return connections;
}

/**
 * Create a connection (folder-watch inline create → type "s3"). gdrive/dropbox
 * are created via the OAuth flow, not this POST (the server 501s a direct
 * create for them).
 */
export function createConnection(req: CreateConnectionRequest): Promise<Connection> {
  return post<Connection>(autoTriggerRoutes.connections(), req);
}

/** Verify probe result: the (re-stamped) connection plus the failure detail. */
export type VerifyConnectionResult = Connection & { verifyError?: string };

/** POST /api/auto/connections/{id}/verify — cheap side-effect-free probe;
 *  stamps status ok|error and returns the connection (+ verifyError on failure). */
export function verifyConnection(id: string): Promise<VerifyConnectionResult> {
  return post<VerifyConnectionResult>(`${autoTriggerRoutes.connection(id)}/verify`);
}
