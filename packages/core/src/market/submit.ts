/**
 * Hosted-AgentKitMarket submit operation, ported from the Rust
 * `submit_hosted_market_kit` / `submit_package_to_hosted_market` /
 * `upload_hosted_market_submission_package`.
 *
 * Flow: validate (publishable) → package to a temp .agentkit.zip → sha256 →
 * POST upload-url (Bearer) → upload package bytes (PUT or multipart, see
 * upload.ts) → POST validate with sha256 → structured result.
 *
 * Reuses the pure spec ENGINE for validation/packaging. The engine never
 * imports this module (one-way: market → engine).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getDefaultPackageName } from "../artifacts/naming.js";
import { getAgentKitSummary } from "../app/summary.js";
import { packageAgentKit } from "../package/packager.js";
import { getAgentKitVersion } from "../package/version.js";
import { validateAgentKit } from "../validation/validator.js";
import type { ValidationReport } from "../types.js";

import { forgeMarketRoutes } from "./routes.js";
import {
  authedRequest,
  normalizeMarketBaseUrl,
  type FetchLike,
  type MarketRequestOptions
} from "./http.js";
import type { TokenStore } from "./types.js";
import {
  buildMultipartBody,
  planPackageUpload,
  sha256Hex,
  type PresignedUpload
} from "./upload.js";

/** The listing draft sent in the upload-url request (matches contract). */
export interface ListingDraft {
  name: string;
  summary: string;
  description: string;
  categories: string[];
  tags: string[];
}

/** Body of POST /api/forge/submissions/upload-url (matches contract). */
export interface ForgeUploadRequest {
  fileName: string;
  version: string;
  publisherId: string;
  listingDraft: ListingDraft;
}

export interface SubmitKitOptions extends MarketRequestOptions {
  /** Path to the Agent Kit root folder to submit. */
  rootPath: string;
  /**
   * Optional publisher hint. The Market server authoritatively resolves the
   * publisher from the authenticated user's AgentKitProfile and ignores this
   * value, so it is not required and defaults to empty.
   */
  publisherId?: string;
  /** Override the listing draft; otherwise derived from the kit summary. */
  listingDraft?: Partial<ListingDraft>;
  /** Override the package file name; default derived from id+version. */
  fileName?: string;
}

export interface SubmitKitResult {
  submissionId: string;
  status: string;
  marketLink: string;
  sha256: string;
  packagePath: string;
  validationReport: ValidationReport;
}

interface UploadUrlResponse {
  submissionId?: string;
  id?: string;
  uploadUrl?: string;
  method?: string;
  fields?: Record<string, unknown> | null;
  headers?: Record<string, unknown> | null;
  status?: string;
  marketLink?: string;
  submissionUrl?: string;
  url?: string;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Build the upload-url request body from the kit summary. The summary is the
 * canonical engine view of name/version/description; the listing summary is the
 * first non-empty description line, mirroring the Rust client.
 */
export async function buildForgeUploadRequest(
  rootPath: string,
  publisherId: string,
  fileNameOverride?: string,
  listingOverride?: Partial<ListingDraft>
): Promise<ForgeUploadRequest> {
  const summary = await getAgentKitSummary(rootPath);
  // Use the canonical sequential version (legacy semver normalized to "1"),
  // not the raw manifest value, so submissions carry the displayed vN scheme.
  const version = await getAgentKitVersion(rootPath);
  const description = summary.description ?? "";
  const firstLine = description
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const fileName =
    fileNameOverride ?? getDefaultPackageName({ id: summary.id, version });
  return {
    fileName,
    version,
    publisherId: publisherId.trim(),
    listingDraft: {
      name: listingOverride?.name ?? summary.name,
      summary: listingOverride?.summary ?? firstLine ?? summary.name,
      description: listingOverride?.description ?? description,
      categories: listingOverride?.categories ?? [],
      tags: listingOverride?.tags ?? []
    }
  };
}

async function uploadPackageBytes(
  fetchImpl: FetchLike,
  presigned: PresignedUpload,
  fileName: string,
  bytes: Uint8Array
): Promise<void> {
  const plan = planPackageUpload(presigned);
  let response;
  if (plan.kind === "multipart") {
    const { body, contentType } = buildMultipartBody(plan.fields, fileName, bytes);
    response = await fetchImpl(plan.url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body
    });
  } else {
    response = await fetchImpl(plan.url, {
      method: plan.method,
      headers: plan.headers,
      body: bytes
    });
  }
  if (!response.ok) {
    throw new Error(
      `Unable to upload package to hosted AgentKitMarket. Status: ${response.status}.`
    );
  }
}

/**
 * Validate, package, and submit an Agent Kit to the hosted Market. Throws on
 * validation failure (before any network), on non-2xx Market responses, or with
 * a reconnect error if the session cannot be refreshed.
 */
export async function submitKit(
  store: TokenStore,
  options: SubmitKitOptions
): Promise<SubmitKitResult> {
  const marketBaseUrl = normalizeMarketBaseUrl(options.marketBaseUrl);
  const reqOptions: MarketRequestOptions = { ...options, marketBaseUrl };
  const fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);

  // The server resolves the publisher from the authenticated user's profile and
  // ignores any value we send, so we do not gate on it here (and must not — that
  // gate previously forced a redundant client-side display-name fetch).
  const publisherId = options.publisherId?.trim() ?? "";

  const validationReport = await validateAgentKit(options.rootPath, "publishable");
  if (!validationReport.valid) {
    const errors = validationReport.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message)
      .join(" ");
    throw new Error(
      `Validation failed before Market submission.${errors ? ` ${errors}` : ""}`
    );
  }

  const uploadRequest = await buildForgeUploadRequest(
    options.rootPath,
    publisherId,
    options.fileName,
    options.listingDraft
  );

  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "agentkitforge-market-submit-")
  );
  try {
    const packagePath = path.join(tempRoot, uploadRequest.fileName);
    await packageAgentKit(options.rootPath, packagePath);
    const bytes = await readFile(packagePath);
    const sha256 = sha256Hex(bytes);

    const uploadUrlEndpoint = marketBaseUrl + forgeMarketRoutes.submissionUploadUrl();
    const uploadUrlResponse = await authedRequest(store, reqOptions, (token) =>
      fetchImpl(uploadUrlEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(uploadRequest)
      })
    );
    if (!uploadUrlResponse.ok) {
      const body = await uploadUrlResponse.text().catch(() => "");
      throw new Error(
        `Hosted Market could not start the submission (request upload URL). Status: ${uploadUrlResponse.status}.${
          body ? ` ${body}` : ""
        }`
      );
    }
    const submission = (await uploadUrlResponse.json()) as UploadUrlResponse;
    const submissionId = trimmed(submission.submissionId) ?? trimmed(submission.id);
    if (!submissionId) {
      throw new Error("Hosted Market did not return a submission id.");
    }
    const uploadUrl = trimmed(submission.uploadUrl);
    if (!uploadUrl) {
      throw new Error("Hosted Market did not return an upload URL.");
    }

    await uploadPackageBytes(
      fetchImpl,
      {
        uploadUrl,
        method: submission.method,
        fields: submission.fields,
        headers: submission.headers
      },
      uploadRequest.fileName,
      bytes
    );

    const validateEndpoint =
      marketBaseUrl + forgeMarketRoutes.submissionValidate(submissionId);
    const validateResponse = await authedRequest(store, reqOptions, (token) =>
      fetchImpl(validateEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ sha256 })
      })
    );
    if (!validateResponse.ok) {
      const body = await validateResponse.text().catch(() => "");
      throw new Error(
        `Hosted Market could not start validation. Status: ${validateResponse.status}.${
          body ? ` ${body}` : ""
        }`
      );
    }
    const validation = (await validateResponse
      .json()
      .catch(() => ({}))) as UploadUrlResponse;

    const status =
      trimmed(submission.status) ?? trimmed(validation.status) ?? "validating";
    const marketLink =
      trimmed(submission.marketLink) ??
      trimmed(submission.submissionUrl) ??
      trimmed(submission.url) ??
      trimmed(validation.marketLink) ??
      trimmed(validation.submissionUrl) ??
      trimmed(validation.url) ??
      `${marketBaseUrl}/submissions/${submissionId}`;

    return {
      submissionId,
      status,
      marketLink,
      sha256,
      packagePath,
      validationReport
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
