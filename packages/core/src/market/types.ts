/**
 * Public types for the hosted-AgentKitMarket auth foundation.
 *
 * This module is NETWORK + AUTH code and is intentionally isolated behind the
 * `@agentkitforge/core/market` subpath. The pure spec engine (validate/package/
 * export) must never import anything from `src/market/`.
 */

/** A WorkOS user as returned by the device-token / refresh responses. */
export interface WorkosUser {
  id?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  profilePictureUrl?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The persisted session shape. This is what a {@link TokenStore} round-trips.
 * Tokens are secrets — never log `accessToken`/`refreshToken`.
 */
export interface StoredSession {
  accessToken: string;
  refreshToken?: string;
  user?: WorkosUser;
  /** ISO-8601 timestamp of when the session was connected/last rotated. */
  connectedAt: string;
}

/**
 * Storage leaf for the session. Core owns ALL auth logic; the storage backend
 * is dependency-injected so the desktop app can supply its Rust-backed secure
 * storage while the CLI uses the cross-platform default store.
 */
export interface TokenStore {
  get(): Promise<StoredSession | null>;
  set(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}
