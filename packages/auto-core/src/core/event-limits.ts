/**
 * Storage caps for the event-driven expansion stores (repository semantics —
 * NOT wire limits; those live in @agentkitforge/contracts, e.g.
 * EVENT_PAYLOAD_MAX_BYTES).
 *
 * Both persistent adapters (selfhost Postgres + aws DynamoDB) enforce these on
 * append (ring-buffer semantics: the newest N rows are kept, older rows are
 * evicted). Mechanism defaults, not commercial values.
 */

/** Ring-buffer cap: newest received events kept PER EVENT SOURCE. */
export const RECEIVED_EVENTS_PER_SOURCE_CAP = 100;

/** Ring-buffer cap: newest fire-log rows kept PER TRIGGER. */
export const FIRE_LOGS_PER_TRIGGER_CAP = 500;

/**
 * Received-event TTL (ms). The DynamoDB adapter stamps a `ttl` epoch-seconds
 * attribute (native table TTL expiry); the Postgres adapter enforces it on
 * prune. 30 days — the inspector buffer is diagnostic, not an archive.
 */
export const RECEIVED_EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
