import type { KitDownloadResponse } from "@/lib/market-api";

type JsonObject = Record<string, unknown>;

export function normalizeKitDownloadResponse(value: unknown): KitDownloadResponse {
  const source = asObject(value);
  const downloadUrl = requiredString(source.downloadUrl, "downloadUrl");
  const slug = optionalString(source.slug);

  const response: KitDownloadResponse = {
    downloadUrl,
    expiresIn: typeof source.expiresIn === "number" ? source.expiresIn : undefined,
    fileName: optionalString(source.fileName),
    kitId: optionalString(source.kitId),
    packageSizeBytes: optionalNumber(source.packageSizeBytes),
    sha256: optionalString(source.sha256),
    version: optionalString(source.version)
  };

  if (slug) {
    response.slug = slug;
  }

  return response;
}

export async function readDownloadErrorMessage(response: Response) {
  const fallback = downloadErrorFallback(response.status);

  try {
    const payload = (await response.json()) as unknown;
    if (isObject(payload) && typeof payload.message === "string" && payload.message.trim()) {
      return payload.message;
    }
  } catch {
    // Keep the status-specific fallback when the response is not JSON.
  }

  return fallback;
}

export function downloadErrorFallback(status: number) {
  if (status === 401) {
    return "Sign in is required to download kits.";
  }

  if (status === 403) {
    return "This kit is not available for download.";
  }

  if (status === 404) {
    return "This kit is unavailable.";
  }

  if (status === 409) {
    return "This kit package is not available yet.";
  }

  if (status === 500 || status === 502 || status === 503) {
    return "Downloads are temporarily unavailable.";
  }

  return `Download request failed with status ${status}.`;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Download response is missing ${label}.`);
  }

  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asObject(value: unknown): JsonObject {
  if (!isObject(value)) {
    throw new Error("Download response was not a JSON object.");
  }

  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
