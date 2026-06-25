/**
 * Hosted-AgentKitMarket download operation, ported from the Rust
 * `request_hosted_market_download_info` + `download_market_package`.
 *
 * Flow: POST /api/forge/kits/{slug}/download (Bearer) → read presigned
 * download URL + provenance → GET the presigned URL → return package bytes
 * (and provenance fields for Bridge 5).
 */

import { forgeMarketRoutes } from "./routes.js";
import {
  authedRequest,
  normalizeMarketBaseUrl,
  type FetchLike,
  type MarketRequestOptions
} from "./http.js";
import type { TokenStore } from "./types.js";
import { sha256Hex } from "./upload.js";

/** Provenance fields captured at download time; feed Bridge 5 metadata. */
export interface MarketProvenance {
  source: "market";
  marketBaseUrl: string;
  marketSlug: string;
  marketKitId?: string;
  version?: string;
  sha256?: string;
  publishedAt?: string;
  sourceUrl?: string;
  fileName: string;
  packageSizeBytes?: number;
}

export interface DownloadKitOptions extends MarketRequestOptions {
  /** Slug, kit ID, or Market URL identifying the kit to download. */
  slug: string;
  /** Optional explicit kit ID (preferred for the download identifier). */
  kitId?: string;
}

export interface DownloadKitResult {
  bytes: Uint8Array;
  provenance: MarketProvenance;
}

interface DownloadInfoResponse {
  downloadUrl?: string;
  fileName?: string;
  version?: string;
  sha256?: string;
  packageSizeBytes?: number;
  expiresIn?: number;
  marketKitId?: string;
  publishedAt?: string;
  sourceUrl?: string;
  status?: string;
  listingStatus?: string;
  lifecycleStatus?: string;
  state?: string;
}

const SLUG_PATH = /\/kits?\/([^/?#]+)/i;

/**
 * Normalize a slug/ID/URL into a Market identifier. A full Market URL has its
 * `/kits/<slug>` segment extracted; otherwise the trimmed value is used.
 */
export function normalizeMarketIdentifier(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Enter a Market kit slug or ID before importing.");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const match = SLUG_PATH.exec(new URL(trimmed).pathname);
    if (match?.[1]) return decodeURIComponent(match[1]);
    throw new Error("Could not find a kit slug in that Market URL.");
  }
  return trimmed;
}

function lifecycleBlock(info: DownloadInfoResponse): string | undefined {
  const blocking = ["hidden", "removed", "rejected", "archived", "canceled"];
  for (const candidate of [
    info.listingStatus,
    info.lifecycleStatus,
    info.status,
    info.state
  ]) {
    const value = candidate?.trim().toLowerCase();
    if (value && blocking.includes(value)) {
      return `This Market kit is not available for download (status: ${value}).`;
    }
  }
  return undefined;
}

function safeFileName(fileName: string | undefined, slug: string): string {
  const name =
    fileName?.trim() && fileName.trim().length > 0
      ? fileName.trim()
      : `${slug.replace(/[^a-zA-Z0-9._-]+/g, "-")}.agentkit.zip`;
  if (name.includes("/") || name.includes("\\")) {
    throw new Error("Hosted Market returned an unsafe package file name.");
  }
  if (!name.endsWith(".agentkit.zip")) {
    throw new Error("Hosted Market package file name must end with .agentkit.zip.");
  }
  return name;
}

/**
 * Assemble provenance metadata from the download-info response and the request
 * inputs. Pure and testable. `sha256` here is the server-claimed checksum; the
 * caller may overwrite it with the locally-computed digest after download.
 */
export function assembleProvenance(
  info: DownloadInfoResponse,
  marketBaseUrl: string,
  slug: string,
  kitId: string | undefined
): MarketProvenance {
  return {
    source: "market",
    marketBaseUrl,
    marketSlug: slug,
    marketKitId: info.marketKitId?.trim() || kitId,
    version: info.version?.trim() || undefined,
    sha256: info.sha256?.trim().toLowerCase() || undefined,
    publishedAt: info.publishedAt?.trim() || undefined,
    sourceUrl:
      info.sourceUrl?.trim() ||
      `${marketBaseUrl}/kits/${encodeURIComponent(slug)}`,
    fileName: safeFileName(info.fileName, slug),
    packageSizeBytes: info.packageSizeBytes
  };
}

/**
 * Download a kit package from the hosted Market. Returns the package bytes and
 * provenance metadata. Verifies the server-claimed sha256/size when present.
 */
export async function downloadKit(
  store: TokenStore,
  options: DownloadKitOptions
): Promise<DownloadKitResult> {
  const marketBaseUrl = normalizeMarketBaseUrl(options.marketBaseUrl);
  const reqOptions: MarketRequestOptions = { ...options, marketBaseUrl };
  const fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);

  const slug = normalizeMarketIdentifier(options.slug);
  const identifier = options.kitId?.trim() || slug;

  const endpoint = marketBaseUrl + forgeMarketRoutes.download(identifier);
  const infoResponse = await authedRequest(store, reqOptions, (token) =>
    fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    })
  );
  if (!infoResponse.ok) {
    const body = await infoResponse.text().catch(() => "");
    throw new Error(
      `Hosted Market could not provide download information. Status: ${infoResponse.status}.${
        body ? ` ${body}` : ""
      }`
    );
  }
  const info = (await infoResponse.json()) as DownloadInfoResponse;

  const lifecycle = lifecycleBlock(info);
  if (lifecycle) throw new Error(lifecycle);
  const downloadUrl = info.downloadUrl?.trim();
  if (!downloadUrl) {
    throw new Error("Hosted Market did not return a download URL.");
  }
  if (info.expiresIn === 0) {
    throw new Error("Hosted Market download URL expired. Try the import again.");
  }

  const parsed = new URL(downloadUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("Hosted Market download URL must use HTTPS.");
  }

  const packageResponse = await fetchImpl(downloadUrl, { method: "GET" });
  if (!packageResponse.ok) {
    throw new Error(
      `Unable to download Market package. Status: ${packageResponse.status}.`
    );
  }
  const bytes = new Uint8Array(await packageResponse.arrayBuffer());

  if (
    typeof info.packageSizeBytes === "number" &&
    info.packageSizeBytes !== bytes.length
  ) {
    throw new Error(
      `Downloaded Market package size did not match the expected size. Expected ${info.packageSizeBytes} bytes, got ${bytes.length} bytes.`
    );
  }

  const actualSha256 = sha256Hex(bytes);
  const expectedSha256 = info.sha256?.trim().toLowerCase();
  if (expectedSha256 && expectedSha256.length > 0 && actualSha256 !== expectedSha256) {
    throw new Error(
      "Downloaded Market package checksum did not match. The package was not imported."
    );
  }

  const provenance = assembleProvenance(info, marketBaseUrl, slug, options.kitId);
  // Trust the locally-computed digest in the returned provenance.
  provenance.sha256 = actualSha256;
  provenance.packageSizeBytes = bytes.length;

  return { bytes, provenance };
}
