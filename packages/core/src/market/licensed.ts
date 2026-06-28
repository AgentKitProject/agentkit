/**
 * Hosted-AgentKitMarket licensed-kit (Tier-2 paid/online-only) operations.
 *
 * Unlike {@link downloadKit}, which returns a freely-distributable package via a
 * presigned URL, a PAID kit's bytes come from the entitlement-gated, watermarked
 * licensed-package route (Seam A: `POST /api/forge/kits/{slug}/licensed-package`,
 * Bearer auth). This module fetches those bytes IN MEMORY and NEVER writes them
 * to disk — that no-persist guarantee is the whole point of "online-only" kits.
 *
 * The caller decides what to do with the bytes:
 *   - online-only (`pricing === 'paid' && !downloadable`): in-memory preview ONLY;
 *     callers MUST NOT persist (`onlineOnly` is surfaced so the UI can enforce this).
 *   - downloadable paid kit the user is entitled to: the SAME watermarked bytes may
 *     be saved (callers should save THESE, never the public download).
 *
 * Free kits use the existing public `downloadKit`/`importKit` path; this module
 * is only for entitlement-gated licensed packages.
 */

import {
  forgePricingRoutes,
  ONLINE_ONLY_RUN_REQUIRED,
  type OnlineOnlyRunDirective,
  type OnlineOnlyRunTargets
} from "@agentkitforge/contracts";
import {
  authedRequest,
  normalizeMarketBaseUrl,
  type FetchLike,
  type MarketRequestOptions
} from "./http.js";
import type { TokenStore } from "./types.js";
import { normalizeMarketIdentifier } from "./download.js";
import { sha256Hex } from "./upload.js";

/** Whether a kit is online-only (paid + not downloadable) — cannot be persisted. */
export function isOnlineOnly(pricing: string | undefined, downloadable: unknown): boolean {
  return pricing === "paid" && downloadable !== true;
}

export interface FetchLicensedKitOptions extends MarketRequestOptions {
  /** Slug, kit ID, or Market URL identifying the licensed kit. */
  slug: string;
  /**
   * Opt-in to receive the CONTENT (bytes) of an ONLINE-ONLY (paid && !downloadable)
   * kit. Default `false`. This is a SECURITY gate (M6 Slice 1): a protected kit's
   * instruction content must NEVER reach a CLIENT (desktop app, browser, CLI) — only
   * legitimate SERVER-SIDE RUN surfaces (the web-Forge gateway per-turn resolver / the
   * Auto worker) pass this. When `false` and the kit is online-only, this function
   * THROWS {@link OnlineOnlyContentRefusedError} instead of returning bytes.
   *
   * Downloadable paid kits and free kits are unaffected — they always return bytes.
   */
  allowOnlineOnlyContent?: boolean;
}

/**
 * Thrown when a CLIENT requests the CONTENT of an online-only (paid &&
 * !downloadable) kit without the explicit server-side opt-in
 * ({@link FetchLicensedKitOptions.allowOnlineOnlyContent}). The kit is
 * OUTPUT-ONLY: it must be RUN server-side (web Forge / Auto), never handed to a
 * client. Carries the public, content-free run directive so the caller can show
 * the user where to run it.
 */
export class OnlineOnlyContentRefusedError extends Error {
  readonly code = ONLINE_ONLY_RUN_REQUIRED;
  readonly onlineOnly = true as const;
  readonly directive: OnlineOnlyRunDirective;
  constructor(directive: OnlineOnlyRunDirective) {
    super(directive.message);
    this.name = "OnlineOnlyContentRefusedError";
    this.directive = directive;
  }
}

/** Watermark stamped into the per-buyer package by the backend. */
export interface LicensedWatermark {
  entitlementId: string;
  userId: string;
  kitId: string;
  grantedAt: string;
  hash: string;
}

export interface FetchLicensedKitResult {
  /** The watermarked .agentkit.zip bytes, held in memory only. */
  bytes: Uint8Array;
  fileName: string;
  /** Locally-computed sha256 of the returned bytes (hex, lowercase). */
  sha256: string;
  /** Server-reported sha256, if any (verified to match the bytes). */
  reportedSha256?: string;
  kitId: string;
  userId: string;
  entitlementId: string;
  licenseVersion: string;
  watermark?: LicensedWatermark;
  pricing: "free" | "paid";
  downloadable: boolean;
  /**
   * True when the kit is online-only (paid && !downloadable). Callers MUST NOT
   * write the bytes to disk or any library when this is true.
   */
  onlineOnly: boolean;
}

interface LicensedPackageResponseBody {
  kitId?: string;
  userId?: string;
  entitlementId?: string;
  fileName?: string;
  contentBase64?: string;
  sha256?: string;
  licenseVersion?: string;
  watermark?: LicensedWatermark;
  pricing?: string;
  downloadable?: boolean;
  onlineOnly?: boolean;
  message?: string;
  /** Output-only run directive discriminator (HTTP 402 body). */
  code?: string;
  /** Public run-target URLs carried on the output-only directive. */
  runTargets?: OnlineOnlyRunTargets;
}

/** Build the public, content-free output-only directive from a response body. */
function toOnlineOnlyDirective(
  body: LicensedPackageResponseBody,
  slug: string
): OnlineOnlyRunDirective {
  return {
    onlineOnly: true,
    code: ONLINE_ONLY_RUN_REQUIRED,
    slug,
    ...(typeof body.kitId === "string" && body.kitId.length > 0 ? { kitId: body.kitId } : {}),
    message:
      typeof body.message === "string" && body.message.length > 0
        ? body.message
        : "This kit is output-only — run it on web Forge or Auto.",
    ...(body.runTargets ? { runTargets: body.runTargets } : {})
  };
}

function decodeBase64(value: string): Uint8Array {
  // Node Buffer is available in the headless bridge/CLI runtime; fall back to
  // atob for completeness if Buffer is unavailable.
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function safeLicensedFileName(fileName: string | undefined, slug: string): string {
  const name =
    fileName?.trim() && fileName.trim().length > 0
      ? fileName.trim()
      : `${slug.replace(/[^a-zA-Z0-9._-]+/g, "-")}.agentkit.zip`;
  if (name.includes("/") || name.includes("\\")) {
    throw new Error("Hosted Market returned an unsafe licensed-package file name.");
  }
  if (!name.endsWith(".agentkit.zip")) {
    throw new Error("Hosted Market licensed-package file name must end with .agentkit.zip.");
  }
  return name;
}

/**
 * Fetch an entitlement-gated, watermarked licensed kit package IN MEMORY.
 *
 * Never writes to disk. Throws a clear error when the user lacks an active
 * entitlement (HTTP 403) or payment is not yet available (HTTP 402). The caller
 * is responsible for honoring {@link FetchLicensedKitResult.onlineOnly} — this
 * function returns the bytes either way (downloadable paid kits may be saved).
 */
export async function fetchLicensedKit(
  store: TokenStore,
  options: FetchLicensedKitOptions
): Promise<FetchLicensedKitResult> {
  const marketBaseUrl = normalizeMarketBaseUrl(options.marketBaseUrl);
  const reqOptions: MarketRequestOptions = { ...options, marketBaseUrl };
  const fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);

  const slug = normalizeMarketIdentifier(options.slug);
  const endpoint = marketBaseUrl + forgePricingRoutes.licensedPackage(slug);

  const response = await authedRequest(store, reqOptions, (token) =>
    fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    })
  );

  if (response.status === 402) {
    // 402 is now the OUTPUT-ONLY directive for protected (online-only) kits
    // (M6 Slice 1). The legitimate server-side run path opts in and unwraps the
    // refusal into a typed error it handles; a client gets the same refusal.
    const body = (await response.json().catch(() => ({}))) as LicensedPackageResponseBody;
    if (body.code === ONLINE_ONLY_RUN_REQUIRED || body.onlineOnly === true) {
      throw new OnlineOnlyContentRefusedError(toOnlineOnlyDirective(body, slug));
    }
    // Legacy 402 (e.g. pre-Slice-1 "payment coming soon") — keep the old message.
    throw new Error(
      body.message ?? "This paid kit cannot be acquired yet — payment is coming soon."
    );
  }
  if (response.status === 403) {
    const body = (await response.json().catch(() => ({}))) as LicensedPackageResponseBody;
    throw new Error(
      body.message ?? "You do not have an active entitlement for this kit."
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Hosted Market could not provide the licensed package. Status: ${response.status}.${
        text ? ` ${text}` : ""
      }`
    );
  }

  const body = (await response.json()) as LicensedPackageResponseBody;

  // Defense-in-depth (M6 Slice 1): if the response (or the kit's pricing) says this
  // is an ONLINE-ONLY protected kit, refuse to surface bytes UNLESS the caller is a
  // legitimate server-side run path that explicitly opted in. This protects against
  // an un-updated commercial handler (or any future caller) that still ships bytes
  // for a protected kit — a client (no opt-in) never receives content.
  const responsePricing = body.pricing === "paid" ? "paid" : "free";
  const responseDownloadable = body.downloadable === true;
  const responseOnlineOnly =
    typeof body.onlineOnly === "boolean"
      ? body.onlineOnly
      : isOnlineOnly(responsePricing, responseDownloadable);
  if (responseOnlineOnly && options.allowOnlineOnlyContent !== true) {
    throw new OnlineOnlyContentRefusedError(toOnlineOnlyDirective(body, slug));
  }

  if (typeof body.contentBase64 !== "string" || body.contentBase64.length === 0) {
    throw new Error("Hosted Market licensed-package response did not include package bytes.");
  }

  const bytes = decodeBase64(body.contentBase64);
  const actualSha256 = sha256Hex(bytes);
  const reportedSha256 = body.sha256?.trim().toLowerCase();
  if (reportedSha256 && reportedSha256.length > 0 && reportedSha256 !== actualSha256) {
    throw new Error(
      "Licensed Market package checksum did not match. The package was not used."
    );
  }

  const pricing = body.pricing === "paid" ? "paid" : "free";
  const downloadable = body.downloadable === true;

  return {
    bytes,
    fileName: safeLicensedFileName(body.fileName, slug),
    sha256: actualSha256,
    reportedSha256,
    kitId: body.kitId ?? slug,
    userId: body.userId ?? "",
    entitlementId: body.entitlementId ?? "",
    licenseVersion: body.licenseVersion ?? "",
    watermark: body.watermark,
    pricing,
    downloadable,
    onlineOnly:
      typeof body.onlineOnly === "boolean"
        ? body.onlineOnly
        : isOnlineOnly(pricing, downloadable)
  };
}

export interface CheckEntitlementOptions extends MarketRequestOptions {
  slug: string;
}

export interface EntitlementStatusResult {
  slug: string;
  kitId?: string;
  pricing: "free" | "paid";
  downloadable: boolean;
  onlineOnly: boolean;
  entitled: boolean;
}

/**
 * Check whether the authenticated user holds an active entitlement for a kit.
 * Reads the per-user entitlement list (no bytes fetched). Pure read.
 */
export async function checkEntitlement(
  store: TokenStore,
  options: CheckEntitlementOptions
): Promise<EntitlementStatusResult> {
  const marketBaseUrl = normalizeMarketBaseUrl(options.marketBaseUrl);
  const reqOptions: MarketRequestOptions = { ...options, marketBaseUrl };
  const fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);

  const slug = normalizeMarketIdentifier(options.slug);
  const endpoint =
    marketBaseUrl + `/api/forge/kits/${encodeURIComponent(slug)}/entitlement`;

  const response = await authedRequest(store, reqOptions, (token) =>
    fetchImpl(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    })
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Hosted Market could not check entitlement. Status: ${response.status}.${
        text ? ` ${text}` : ""
      }`
    );
  }
  const body = (await response.json()) as {
    kitId?: string;
    pricing?: string;
    downloadable?: boolean;
    onlineOnly?: boolean;
    entitled?: boolean;
  };
  const pricing = body.pricing === "paid" ? "paid" : "free";
  const downloadable = body.downloadable === true;
  return {
    slug,
    kitId: body.kitId,
    pricing,
    downloadable,
    onlineOnly:
      typeof body.onlineOnly === "boolean" ? body.onlineOnly : isOnlineOnly(pricing, downloadable),
    entitled: body.entitled === true
  };
}
