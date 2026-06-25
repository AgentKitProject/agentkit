import { marketBackendRoutes } from "@agentkitforge/contracts";
import type {
  PreparedPromptSummary,
  RequiredInputSummary,
  SkillSummary,
  TrustBadge
} from "@/lib/market-api";
import type { PublisherSnapshot } from "@/lib/profile/types";

export type ValidationStatus = "pending" | "queued" | "running" | "passed" | "failed" | string;

export type ReviewStatus = "pending" | "approved" | "reviewed" | "rejected" | string;

export type SubmissionStatus =
  | "awaiting_upload"
  | "uploaded"
  | "validating"
  | "validated"
  | "validation_queued"
  | "validation_passed"
  | "validation_failed"
  | "published"
  | "hidden"
  | "removed"
  | "rejected"
  | "archived"
  | "canceled"
  | string;

export type AdminSubmissionStatus = ValidationStatus;

export type AdminReviewStatus = ReviewStatus;

export type ListingDraftInput = {
  name: string;
  summary: string;
  description?: string;
  categories: string[];
  tags: string[];
};

export type AdminCreateUploadUrlRequest = {
  fileName: string;
  version: string;
  publisherId: string;
  listingDraft: ListingDraftInput;
};

export type UserCreateUploadUrlBackendRequest = AdminCreateUploadUrlRequest & {
  submittedByUserId: string;
  submittedByEmail: string;
  publisherSnapshot: PublisherSnapshot;
};

export type AdminCreateUploadUrlResponse = {
  submissionId: string;
  uploadUrl: string;
  method?: "PUT" | "POST";
  fields?: Record<string, string>;
  headers?: Record<string, string>;
};

export type AdminUploadRequest = AdminCreateUploadUrlRequest;
export type AdminUploadUrlResponse = AdminCreateUploadUrlResponse;

export type AdminSubmissionListItem = {
  submissionId: string;
  kitId?: string;
  kitSlug?: string;
  name: string;
  summary?: string;
  publisherId?: string;
  publisherName?: string;
  submittedByUserId?: string;
  submittedByEmail?: string;
  version?: string;
  status?: SubmissionStatus;
  validationStatus: ValidationStatus;
  reviewStatus: ReviewStatus;
  reviewNotes?: string;
  reviewedAt?: string;
  publishedAt?: string;
  archivedAt?: string;
  canceledAt?: string;
  removedAt?: string;
  kitStatus?: string;
  hiddenAt?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Total lifetime download count for the associated kit (0 if kit has never been downloaded or is not yet published). */
  kitDownloads?: number;
};

export type AdminValidationSummary = {
  status?: ValidationStatus;
  message?: string;
  checks?: Array<{ name: string; status: string; summary?: string }>;
  errors?: string[];
  warnings?: string[];
};

export type AdminSubmissionDetail = AdminSubmissionListItem & {
  description?: string;
  packageS3Key?: string;
  categories: string[];
  tags: string[];
  validationSummary?: AdminValidationSummary;
  requiredInputs: RequiredInputSummary[];
  preparedPrompts: PreparedPromptSummary[];
  skills: SkillSummary[];
  trustBadges: TrustBadge[];
};

export type SubmissionListItem = AdminSubmissionListItem;
export type SubmissionDetail = AdminSubmissionDetail;

export type AdminActionResponse = {
  ok?: boolean;
  message?: string;
  item?: unknown;
  submission?: unknown;
  kit?: unknown;
  kitId?: string;
  slug?: string;
};

export type KitPublishResponse = AdminActionResponse & {
  kitId?: string;
  slug?: string;
  currentVersion?: string;
};

export class AdminApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

export class AdminConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminConfigError";
  }
}

type JsonObject = Record<string, unknown>;

export function getAdminConfigStatus() {
  const apiBaseUrl = getApiBaseUrl();
  const adminKey = getAdminKey();

  return {
    hasApiBaseUrl: Boolean(apiBaseUrl),
    hasAdminKey: Boolean(adminKey),
    isConfigured: Boolean(apiBaseUrl && adminKey)
  };
}

export async function fetchAdminBackend(path: string, init: RequestInit = {}) {
  const apiBaseUrl = getApiBaseUrl();
  const adminKey = getAdminKey();

  if (!apiBaseUrl || !adminKey) {
    throw new AdminConfigError("Server admin API configuration is incomplete.");
  }

  return fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-agentkitmarket-admin-key": adminKey,
      ...init.headers
    },
    cache: "no-store"
  });
}

export async function createUploadUrl(
  request: AdminCreateUploadUrlRequest | UserCreateUploadUrlBackendRequest
): Promise<AdminCreateUploadUrlResponse> {
  const payload = await adminRequestJson(marketBackendRoutes.adminCreateUploadUrl(), {
    method: "POST",
    body: JSON.stringify(request)
  });
  const raw = asObject(payload);

  return {
    submissionId: requiredString(raw.submissionId, "submissionId"),
    uploadUrl: requiredString(raw.uploadUrl ?? raw.url, "uploadUrl"),
    method: normalizeUploadMethod(raw.method),
    fields: stringRecord(raw.fields),
    headers: stringRecord(raw.headers)
  };
}

export async function startValidation(submissionId: string) {
  return adminRequestJson(marketBackendRoutes.adminValidateSubmission(submissionId), {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function approveSubmission(submissionId: string, reviewNotes?: string): Promise<AdminActionResponse> {
  return adminRequestJson(marketBackendRoutes.adminApproveSubmission(submissionId), {
    method: "POST",
    body: JSON.stringify(notesPayload(reviewNotes))
  }) as Promise<AdminActionResponse>;
}

export async function rejectSubmission(submissionId: string, reviewNotes: string): Promise<AdminActionResponse> {
  return adminRequestJson(marketBackendRoutes.adminRejectSubmission(submissionId), {
    method: "POST",
    body: JSON.stringify(notesPayload(reviewNotes))
  }) as Promise<AdminActionResponse>;
}

export async function publishSubmission(submissionId: string): Promise<KitPublishResponse> {
  return adminRequestJson(marketBackendRoutes.adminPublishSubmission(submissionId), {
    method: "POST",
    body: JSON.stringify({})
  }) as Promise<KitPublishResponse>;
}

export async function hideKit(kitId: string): Promise<AdminActionResponse> {
  return adminRequestJson(marketBackendRoutes.adminHideKit(kitId), {
    method: "POST",
    body: JSON.stringify({})
  }) as Promise<AdminActionResponse>;
}

export async function unhideKit(kitId: string): Promise<AdminActionResponse> {
  return adminRequestJson(marketBackendRoutes.adminUnhideKit(kitId), {
    method: "POST",
    body: JSON.stringify({})
  }) as Promise<AdminActionResponse>;
}

export async function removeKit(kitId: string): Promise<AdminActionResponse> {
  return adminRequestJson(`/admin/kits/${encodeURIComponent(kitId)}/remove`, {
    method: "POST",
    body: JSON.stringify({})
  }) as Promise<AdminActionResponse>;
}

export async function archiveSubmission(submissionId: string): Promise<AdminActionResponse> {
  return adminRequestJson(marketBackendRoutes.adminArchiveSubmission(submissionId), {
    method: "POST",
    body: JSON.stringify({})
  }) as Promise<AdminActionResponse>;
}

export async function removeSubmission(submissionId: string): Promise<AdminActionResponse> {
  return adminRequestJson(`/admin/submissions/${encodeURIComponent(submissionId)}/remove`, {
    method: "POST",
    body: JSON.stringify({})
  }) as Promise<AdminActionResponse>;
}

export async function listSubmissions(query?: URLSearchParams | string): Promise<AdminSubmissionListItem[]> {
  const queryString = query instanceof URLSearchParams ? query.toString() : query;
  const payload = await adminRequestJson(`${marketBackendRoutes.adminListSubmissions()}${queryString ? `?${queryString}` : ""}`);
  const raw = asObject(payload);
  const items = Array.isArray(raw.items) ? raw.items : [];

  return items.map((item) => normalizeSubmissionListItem(asObject(item)));
}

export async function getSubmissionById(submissionId: string): Promise<AdminSubmissionDetail | null> {
  try {
    const payload = await adminRequestJson(`/admin/submissions/${encodeURIComponent(submissionId)}`);
    return normalizeAdminSubmissionDetail(payload);
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) {
      return null;
    }

    throw error;
  }
}

async function adminRequestJson(path: string, init: RequestInit = {}) {
  const apiBaseUrl = getApiBaseUrl();
  const adminKey = getAdminKey();

  if (!apiBaseUrl) {
    throw new AdminConfigError("Missing NEXT_PUBLIC_AGENTKITMARKET_API_BASE_URL.");
  }

  if (!adminKey) {
    throw new AdminConfigError("Missing AGENTKITMARKET_ADMIN_KEY.");
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-agentkitmarket-admin-key": adminKey,
      ...init.headers
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new AdminApiError(await responseErrorMessage(response), response.status);
  }

  if (response.status === 204) {
    return {};
  }

  return response.json();
}

async function responseErrorMessage(response: Response) {
  let message = `Admin API request failed with status ${response.status}.`;

  try {
    const payload = (await response.json()) as unknown;
    if (isObject(payload) && typeof payload.message === "string") {
      message = payload.message;
    }
  } catch {
    // Keep the status fallback when the response is not JSON.
  }

  return message;
}

function normalizeSubmissionListItem(raw: JsonObject): AdminSubmissionListItem {
  const draft = isObject(raw.listingDraft) ? raw.listingDraft : {};
  const submittedBy = isObject(raw.submittedBy) ? raw.submittedBy : {};
  const review = isObject(raw.review) ? raw.review : {};
  const publish = isObject(raw.publish) ? raw.publish : {};
  const archive = isObject(raw.archive) ? raw.archive : {};
  const cancel = isObject(raw.cancel) ? raw.cancel : {};
  const remove = isObject(raw.remove) ? raw.remove : {};
  const kit = isObject(raw.kit) ? raw.kit : {};
  const submissionId = requiredString(raw.submissionId ?? raw.id, "submissionId");

  return {
    submissionId,
    kitId: asOptionalString(raw.kitId),
    kitSlug: asOptionalString(raw.kitSlug ?? raw.slug),
    name: asOptionalString(raw.name) ?? asOptionalString(draft.name) ?? "Untitled submission",
    summary: asOptionalString(raw.summary) ?? asOptionalString(draft.summary),
    publisherId: asOptionalString(raw.publisherId),
    publisherName: asOptionalString(raw.publisherName),
    submittedByUserId: asOptionalString(raw.submittedByUserId ?? submittedBy.userId ?? raw.submitterUserId),
    submittedByEmail: asOptionalString(raw.submittedByEmail ?? submittedBy.email ?? raw.submitterEmail),
    version: asOptionalString(raw.version ?? raw.currentVersion),
    status: asOptionalString(raw.status),
    validationStatus: asOptionalString(raw.validationStatus) ?? "pending",
    reviewStatus: asOptionalString(raw.reviewStatus) ?? "pending",
    reviewNotes: asOptionalString(raw.reviewNotes ?? review.notes),
    reviewedAt: asOptionalString(raw.reviewedAt ?? review.reviewedAt),
    publishedAt: asOptionalString(raw.publishedAt ?? publish.publishedAt),
    archivedAt: asOptionalString(raw.archivedAt ?? archive.archivedAt),
    canceledAt: asOptionalString(raw.canceledAt ?? cancel.canceledAt),
    removedAt: asOptionalString(raw.removedAt ?? remove.removedAt ?? kit.removedAt),
    kitStatus: asOptionalString(raw.kitStatus ?? kit.status),
    hiddenAt: asOptionalString(raw.hiddenAt ?? kit.hiddenAt),
    createdAt: asOptionalString(raw.createdAt),
    updatedAt: asOptionalString(raw.updatedAt),
    kitDownloads: typeof raw.kitDownloads === "number" ? raw.kitDownloads : 0
  };
}

export function normalizeAdminSubmissionDetail(value: unknown): AdminSubmissionDetail {
  const raw = asObject(value);
  const source = raw.item && isObject(raw.item) ? raw.item : raw.submission && isObject(raw.submission) ? raw.submission : raw;
  const draft = isObject(source.listingDraft) ? source.listingDraft : {};
  const item = normalizeSubmissionListItem(source);

  return {
    ...item,
    description: asOptionalString(source.description) ?? asOptionalString(draft.description),
    packageS3Key: asOptionalString(source.packageS3Key),
    categories: stringArray(source.categories).length > 0 ? stringArray(source.categories) : stringArray(draft.categories),
    tags: stringArray(source.tags).length > 0 ? stringArray(source.tags) : stringArray(draft.tags),
    validationSummary: normalizeValidationSummary(source.validationSummary ?? source.validation),
    requiredInputs: summaryArray(source.requiredInputs ?? source.requiredInputSummaries, "input"),
    preparedPrompts: summaryArray(source.preparedPrompts ?? source.preparedPromptSummaries, "prompt"),
    skills: summaryArray(source.skills ?? source.skillSummaries, "skill"),
    trustBadges: stringArray(source.trustBadges ?? source.badges)
  };
}

function normalizeValidationSummary(value: unknown): AdminValidationSummary | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  return {
    status: asOptionalString(value.status),
    message: asOptionalString(value.message ?? value.summary),
    checks: Array.isArray(value.checks)
      ? value.checks.flatMap((check) => {
          if (!isObject(check)) {
            return [];
          }

          return [
            {
              name: asOptionalString(check.name) ?? "Validation check",
              status: asOptionalString(check.status) ?? "unknown",
              summary: asOptionalString(check.summary ?? check.message)
            }
          ];
        })
      : undefined,
    errors: stringArray(value.errors).map(safeValidationMessage).filter(Boolean),
    warnings: stringArray(value.warnings).map(safeValidationMessage).filter(Boolean)
  };
}

function notesPayload(reviewNotes?: string) {
  const notes = reviewNotes?.trim();
  return notes ? { reviewNotes: notes } : {};
}

function summaryArray(value: unknown, fallbackPrefix: string) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry, index) => {
    if (typeof entry === "string") {
      return [{ name: entry }];
    }

    if (!isObject(entry)) {
      return [];
    }

    return [
      {
        name:
          asOptionalString(entry.name) ??
          asOptionalString(entry.title) ??
          asOptionalString(entry.label) ??
          `${fallbackPrefix} ${index + 1}`,
        summary: asOptionalString(entry.summary ?? entry.description),
        type: asOptionalString(entry.type),
        required: asOptionalBoolean(entry.required),
        purpose: asOptionalString(entry.purpose),
        capability: asOptionalString(entry.capability)
      }
    ];
  });
}

function normalizeUploadMethod(value: unknown) {
  return value === "POST" ? "POST" : "PUT";
}

function stringRecord(value: unknown) {
  if (!isObject(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdminApiError(`The admin API response is missing ${label}.`);
  }

  return value;
}

function asObject(value: unknown): JsonObject {
  if (!isObject(value)) {
    throw new AdminApiError("The admin API response was not a JSON object.");
  }

  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function safeValidationMessage(value: string) {
  return value
    .replace(/(?:\/[^\s)]+)+/g, "[path hidden]")
    .replace(/\b(?:at\s+)?[A-Za-z0-9_.$<>]+\([^)]*:\d+:\d+\)/g, "[stack frame hidden]")
    .replace(/\s+/g, " ")
    .slice(0, 280)
    .trim();
}

function getApiBaseUrl() {
  return process.env.NEXT_PUBLIC_AGENTKITMARKET_API_BASE_URL?.replace(/\/+$/, "");
}

function getAdminKey() {
  return process.env.AGENTKITMARKET_ADMIN_KEY;
}
