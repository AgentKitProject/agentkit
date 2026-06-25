/**
 * Read-only Market UPDATE-CHECK (Bridge 5, core half).
 *
 * Given an installed kit's provenance (`marketBaseUrl`, `slug`, installed
 * `version`), ask the PUBLIC catalog whether a newer published version exists.
 *
 * Tokenless by design: the public kit-detail route requires no auth, so update
 * checks keep working even when the user's hosted-Market session is expired.
 * NO automatic updates — this only reports availability; the app decides.
 *
 * Pure/headless: networking goes through an injectable `fetch` (defaults to the
 * global `fetch`). Never throws on network/parse failure — degrades to an
 * `error` reason so the app can surface "couldn't check" gracefully.
 */

import {
  forgeMarketRoutes,
  publicKitDetailResponseSchema
} from "@agentkitforge/contracts";

import { normalizeVersionToInt } from "../package/version.js";
import { normalizeMarketBaseUrl, type FetchLike } from "./http.js";
import { normalizeMarketIdentifier } from "./download.js";

/** Result of a read-only update check. Mutually-exclusive `reason` summary. */
export interface KitUpdateStatus {
  /** True when the kit is still publicly available and a version was read. */
  available: boolean;
  /** Canonical latest published version string (e.g. "2"), when available. */
  latestVersion?: string;
  /** True when the latest published version is greater than the installed one. */
  updateAvailable: boolean;
  /**
   * - `ok`: detail fetched, versions compared.
   * - `not_found`: kit gone/unlisted (404 / not public).
   * - `unavailable`: detail fetched but no usable published version.
   * - `error`: network/parse failure (never thrown).
   */
  reason?: "ok" | "not_found" | "unavailable" | "error";
}

export interface CheckKitUpdateOptions {
  /** Hosted-Market base URL (e.g. https://market.agentkitproject.com). */
  marketBaseUrl: string;
  /** Slug, kit ID, or Market URL identifying the kit. */
  slug: string;
  /** The locally-installed kit content version (legacy/non-integer → 1). */
  installedVersion: string;
  /** Injectable fetch, defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/**
 * Extract the latest PUBLISHED version string from a validated kit-detail item.
 *
 * The market backend (`toPublicKitDetail`) exposes the latest published version
 * two ways: the top-level `item.currentVersion` pointer, and the resolved
 * `item.latestVersion.version` record (the version row matching
 * `currentVersion`). We prefer `currentVersion`, falling back to
 * `latestVersion.version`.
 */
function extractLatestVersion(item: {
  currentVersion?: string | null;
  latestVersion?: { version?: string | null } | null;
}): string | undefined {
  const current = item.currentVersion;
  if (typeof current === "string" && current.trim().length > 0) {
    return current.trim();
  }
  const nested = item.latestVersion?.version;
  if (typeof nested === "string" && nested.trim().length > 0) {
    return nested.trim();
  }
  return undefined;
}

/**
 * Check whether an installed Market kit has a newer published version.
 *
 * GETs the public proxy route `/api/forge/kits/{slug}` (no auth) — the JSON
 * detail endpoint exposed by the Market app (the bare `/kits/{slug}` is an HTML
 * page). Maps:
 * - 200 with a usable version → `{ available, latestVersion, updateAvailable, reason: "ok" }`
 * - 200 but no published version → `{ available: false, reason: "unavailable" }`
 * - 404 / not public → `{ available: false, reason: "not_found" }`
 * - network/parse failure → `{ available: false, reason: "error" }` (no throw)
 */
export async function checkKitUpdate(
  options: CheckKitUpdateOptions
): Promise<KitUpdateStatus> {
  let marketBaseUrl: string;
  let slug: string;
  try {
    marketBaseUrl = normalizeMarketBaseUrl(options.marketBaseUrl);
    slug = normalizeMarketIdentifier(options.slug);
  } catch {
    return { available: false, updateAvailable: false, reason: "error" };
  }

  const fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);
  const endpoint = `${marketBaseUrl}${forgeMarketRoutes.kitDetail(slug)}`;

  let response;
  try {
    response = await fetchImpl(endpoint, { method: "GET" });
  } catch {
    return { available: false, updateAvailable: false, reason: "error" };
  }

  if (response.status === 404) {
    return { available: false, updateAvailable: false, reason: "not_found" };
  }
  if (!response.ok) {
    return { available: false, updateAvailable: false, reason: "error" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { available: false, updateAvailable: false, reason: "error" };
  }

  const parsed = publicKitDetailResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { available: false, updateAvailable: false, reason: "error" };
  }

  const latestRaw = extractLatestVersion(parsed.data.item);
  if (latestRaw === undefined) {
    return { available: false, updateAvailable: false, reason: "unavailable" };
  }

  const latestInt = normalizeVersionToInt(latestRaw);
  const installedInt = normalizeVersionToInt(options.installedVersion);

  return {
    available: true,
    latestVersion: String(latestInt),
    updateAvailable: latestInt > installedInt,
    reason: "ok"
  };
}
