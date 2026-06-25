import type {
  AdminCreateUploadUrlRequest,
  AdminSubmissionDetail,
  AdminSubmissionListItem,
  AdminActionResponse,
  UserCreateUploadUrlBackendRequest
} from "@/lib/admin-api";
import type { PublisherSnapshot } from "@/lib/profile/types";

export type SubmissionUser = {
  id: string;
  email: string;
};

export type UserCreateUploadUrlRequest = Omit<AdminCreateUploadUrlRequest, "publisherId"> & {
  submittedByUserId?: string;
  submittedByEmail?: string;
  publisherSnapshot?: PublisherSnapshot;
};

export function buildUserUploadBackendRequest(
  request: Partial<UserCreateUploadUrlRequest>,
  user: SubmissionUser,
  publisherSnapshot: PublisherSnapshot
): UserCreateUploadUrlBackendRequest {
  return {
    fileName: typeof request.fileName === "string" ? request.fileName.trim() : "",
    version: typeof request.version === "string" ? request.version.trim() : "",
    publisherId: profileDisplayNameAsPublisherId(publisherSnapshot.displayName),
    submittedByUserId: user.id,
    submittedByEmail: user.email,
    publisherSnapshot,
    listingDraft: {
      name: typeof request.listingDraft?.name === "string" ? request.listingDraft.name.trim() : "",
      summary: typeof request.listingDraft?.summary === "string" ? request.listingDraft.summary.trim() : "",
      description:
        typeof request.listingDraft?.description === "string" ? request.listingDraft.description.trim() : "",
      categories: Array.isArray(request.listingDraft?.categories) ? stringArray(request.listingDraft.categories) : [],
      tags: Array.isArray(request.listingDraft?.tags) ? stringArray(request.listingDraft.tags) : []
    }
  };
}

export function filterOwnSubmissions<T extends AdminSubmissionListItem>(items: T[], user: SubmissionUser) {
  return items.filter((item) => isOwnSubmission(item, user));
}

export function buildUserLifecycleRequest(user: SubmissionUser) {
  return { userId: user.id };
}

export function sanitizeUserSubmissionListItem<T extends AdminSubmissionListItem>(item: T) {
  const safeItem: Partial<T> = { ...item };
  delete safeItem.submittedByEmail;
  delete safeItem.submittedByUserId;
  return safeItem;
}

export function sanitizeUserSubmissionDetail<T extends AdminSubmissionDetail>(item: T) {
  const safeItem: Partial<T> = { ...item };
  delete safeItem.packageS3Key;
  delete safeItem.submittedByEmail;
  delete safeItem.submittedByUserId;
  return safeItem;
}

export type UserLifecycleActionResponse = AdminActionResponse;

export function isOwnSubmission(submission: AdminSubmissionListItem | AdminSubmissionDetail, user: SubmissionUser) {
  const normalizedUserEmail = normalizeEmail(user.email);
  const normalizedSubmissionEmail = normalizeEmail(submission.submittedByEmail);

  return (
    submission.submittedByUserId === user.id ||
    (Boolean(normalizedUserEmail) && normalizedUserEmail === normalizedSubmissionEmail) ||
    submission.publisherId === userPublisherId(user)
  );
}

export function userPublisherId(user: SubmissionUser) {
  return `user_${user.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function stringArray(value: unknown[]) {
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function normalizeEmail(email?: string | null) {
  return email?.trim().toLowerCase() ?? "";
}

function profileDisplayNameAsPublisherId(displayName?: string | null) {
  return displayName?.trim() ?? "";
}
