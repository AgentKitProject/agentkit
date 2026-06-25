import { z } from "zod";
import { publisherSnapshotSchema } from "./profile.js";

/**
 * AgentKitMarket seams.
 *
 * Seam A (Forge ↔ market-app): /api/forge/* app-server routes, authenticated
 * with a WorkOS device-auth JWT (`Authorization: Bearer`), verified server-side
 * via JWKS by requireForgeUser(). Never cookie-authenticated.
 *
 * Seam B (market-app ↔ agentkitmarket-infra backend): API Gateway routes,
 * authenticated with the server-only x-agentkitmarket-admin-key header.
 */

export const submissionStatusSchema = z.enum([
  "awaiting_upload",
  "uploaded",
  "validation_queued",
  "validating",
  "validated",
  "validation_passed",
  "validation_failed",
  "published",
  "hidden",
  "removed",
  "rejected",
  "archived",
  "canceled"
]);
export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;

export const validationStatusSchema = z.enum(["pending", "queued", "running", "passed", "failed"]);
export type ValidationStatus = z.infer<typeof validationStatusSchema>;

export const reviewStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

/** Whether a submission registers a brand-new kit or a new version of an existing one. */
export const submissionTypeSchema = z.enum(["new_kit", "version_update"]);
export type SubmissionType = z.infer<typeof submissionTypeSchema>;

export const listingDraftSchema = z.object({
  name: z.string(),
  summary: z.string(),
  description: z.string(),
  categories: z.array(z.string()),
  tags: z.array(z.string())
});
export type ListingDraft = z.infer<typeof listingDraftSchema>;

/** Payload market-app sends to the backend to open a Forge submission. */
export const forgeUploadBackendRequestSchema = z.object({
  fileName: z.string().endsWith(".agentkit.zip"),
  version: z.string().min(1),
  /** The publisher's AgentKitProfile display name (server-resolved, required). */
  publisherId: z.string().min(1),
  listingDraft: listingDraftSchema,
  submittedByUserId: z.string().min(1),
  submittedByEmail: z.string().min(1),
  publisherSnapshot: publisherSnapshotSchema.optional(),
  /** new_kit (default) or version_update of an existing owned kit. */
  submissionType: submissionTypeSchema.optional(),
  /** For version_update: the kitId being updated. Ownership is enforced server-side. */
  targetKitId: z.string().min(1).optional(),
  /**
   * Organization that owns this kit.  Optional for now (personal kits have no ownerOrgId).
   * Populated by Forge when submitting on behalf of an org (Market Phase 2 orgs slice).
   */
  ownerOrgId: z.string().min(1).optional()
});
export type ForgeUploadBackendRequest = z.infer<typeof forgeUploadBackendRequestSchema>;

/** Response Forge receives from POST /api/forge/submissions/upload-url. */
export const forgeUploadUrlResponseSchema = z.object({
  submissionId: z.string().min(1),
  uploadUrl: z.string().url(),
  method: z.enum(["PUT", "POST"]),
  fields: z.record(z.string()),
  headers: z.record(z.string())
});
export type ForgeUploadUrlResponse = z.infer<typeof forgeUploadUrlResponseSchema>;

/**
 * Response Forge receives from POST /api/forge/kits/{slug}/download.
 * Carries the presigned download URL plus provenance used by installed-kit
 * metadata / update detection (Bridge 5).
 */
export const forgeDownloadResponseSchema = z.object({
  downloadUrl: z.string().url(),
  marketKitId: z.string().optional(),
  marketSlug: z.string().optional(),
  version: z.string().optional(),
  sha256: z.string().optional(),
  packageSizeBytes: z.number().optional(),
  publishedAt: z.string().optional(),
  sourceUrl: z.string().optional(),
  fileName: z.string().optional(),
  expiresIn: z.number().optional()
});
export type ForgeDownloadResponse = z.infer<typeof forgeDownloadResponseSchema>;

/** A published kit version's public metadata (from the catalog detail). */
export const publicKitVersionSchema = z.object({
  version: z.string(),
  summary: z.string().nullable().optional(),
  schemaVersion: z.string().nullable().optional(),
  packageSizeBytes: z.number().nullable().optional(),
  sha256: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional()
});
export type PublicKitVersion = z.infer<typeof publicKitVersionSchema>;

/**
 * Public kit detail (inside an `{ item }` envelope) returned by the Market
 * backend GET /kits/{slug} and proxied to Forge via the kit-detail route.
 * Lenient (passthrough): the backend returns more fields than consumers read;
 * `currentVersion`/`latestVersion` drive Bridge 5 update detection.
 *
 * TODO (Market Phase 2): the `publisher` field will migrate from a free-form
 * PublisherSnapshot projection to `PublicOrganizationSchema` once org-owned kits
 * ship.  Do NOT add a typed `publisher` field here until that migration is ready —
 * passthrough keeps it readable without breaking existing consumers.
 */
export const publicKitDetailSchema = z
  .object({
    kitId: z.string(),
    slug: z.string(),
    name: z.string(),
    summary: z.string(),
    description: z.string().nullable().optional(),
    categories: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    currentVersion: z.string().nullable(),
    latestVersion: publicKitVersionSchema.nullable(),
    versions: z.array(publicKitVersionSchema).optional(),
    publishedAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional()
  })
  .passthrough();
export type PublicKitDetail = z.infer<typeof publicKitDetailSchema>;

/** Envelope for the kit-detail response: `{ item: PublicKitDetail }`. */
export const publicKitDetailResponseSchema = z.object({ item: publicKitDetailSchema });
export type PublicKitDetailResponse = z.infer<typeof publicKitDetailResponseSchema>;

/** Routes Forge calls on the Market web app (Seam A). */
export const forgeMarketRoutes = {
  download: (slug: string) => `/api/forge/kits/${encodeURIComponent(slug)}/download`,
  /** Public (no-auth) kit detail proxy for update checks — { item: PublicKitDetail }. */
  kitDetail: (slug: string) => `/api/forge/kits/${encodeURIComponent(slug)}`,
  submissionUploadUrl: () => "/api/forge/submissions/upload-url",
  submissionValidate: (submissionId: string) =>
    `/api/forge/submissions/${encodeURIComponent(submissionId)}/validate`,
  publisherProfile: () => "/api/forge/publisher-profile"
} as const;

/** Routes market-app calls on the Market backend API Gateway (Seam B). */
export const marketBackendRoutes = {
  health: () => "/health",
  listKits: () => "/kits",
  kitBySlug: (slug: string) => `/kits/${encodeURIComponent(slug)}`,
  adminCreateUploadUrl: () => "/admin/submissions/upload-url",
  adminValidateSubmission: (submissionId: string) =>
    `/admin/submissions/${encodeURIComponent(submissionId)}/validate`,
  adminApproveSubmission: (submissionId: string) =>
    `/admin/submissions/${encodeURIComponent(submissionId)}/approve`,
  adminRejectSubmission: (submissionId: string) =>
    `/admin/submissions/${encodeURIComponent(submissionId)}/reject`,
  adminArchiveSubmission: (submissionId: string) =>
    `/admin/submissions/${encodeURIComponent(submissionId)}/archive`,
  adminPublishSubmission: (submissionId: string) =>
    `/admin/submissions/${encodeURIComponent(submissionId)}/publish`,
  adminListSubmissions: () => "/admin/submissions",
  adminGetSubmission: (submissionId: string) =>
    `/admin/submissions/${encodeURIComponent(submissionId)}`,
  adminRemoveSubmission: (submissionId: string) =>
    `/admin/submissions/${encodeURIComponent(submissionId)}/remove`,
  adminDownloadUrlBySlug: (slug: string) => `/admin/kits/by-slug/${encodeURIComponent(slug)}/download-url`,
  adminDownloadUrlByKitId: (kitId: string) =>
    `/admin/kits/${encodeURIComponent(kitId)}/download-url`,
  adminHideKit: (kitId: string) => `/admin/kits/${encodeURIComponent(kitId)}/hide`,
  adminUnhideKit: (kitId: string) => `/admin/kits/${encodeURIComponent(kitId)}/unhide`,
  adminRemoveKit: (kitId: string) => `/admin/kits/${encodeURIComponent(kitId)}/remove`,
  userCancelSubmission: (submissionId: string) =>
    `/users/submissions/${encodeURIComponent(submissionId)}/cancel`,
  userRemoveKit: (kitId: string) => `/users/kits/${encodeURIComponent(kitId)}/remove`
} as const;

/** Server-to-server auth header for Seam B. Server-only — never in browser bundles or Forge. */
export const marketBackendAuthHeader = "x-agentkitmarket-admin-key" as const;
