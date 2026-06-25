import type { AdminSubmissionListItem } from "@/lib/admin-api";

export type ReviewSectionKey =
  | "pending-validation"
  | "validation-failed"
  | "ready-for-review"
  | "approved"
  | "rejected"
  | "published"
  | "archived";

export type AdminActionState = {
  enabled: boolean;
  reason?: string;
};

export function reviewSectionFor(submission: AdminSubmissionListItem): ReviewSectionKey {
  if (isArchived(submission)) {
    return "archived";
  }

  if (isStatus(submission.status, "published")) {
    return "published";
  }

  if (isStatus(submission.reviewStatus, "rejected")) {
    return "rejected";
  }

  if (isStatus(submission.reviewStatus, "approved")) {
    return "approved";
  }

  if (isStatus(submission.validationStatus, "failed")) {
    return "validation-failed";
  }

  if (isStatus(submission.validationStatus, "passed")) {
    return "ready-for-review";
  }

  return "pending-validation";
}

export function approveActionState(submission: AdminSubmissionListItem): AdminActionState {
  if (!isStatus(submission.validationStatus, "passed")) {
    return { enabled: false, reason: "Validation must pass before approval." };
  }

  if (isStatus(submission.reviewStatus, "approved")) {
    return { enabled: false, reason: "Submission is already approved." };
  }

  return { enabled: true };
}

export function rejectActionState(submission: AdminSubmissionListItem, reviewNotes: string): AdminActionState {
  if (isStatus(submission.status, "published")) {
    return { enabled: false, reason: "Published submissions cannot be rejected." };
  }

  if (reviewNotes.trim().length === 0) {
    return { enabled: false, reason: "Review notes are required to reject a submission." };
  }

  return { enabled: true };
}

export function publishActionState(submission: AdminSubmissionListItem): AdminActionState {
  if (!isStatus(submission.validationStatus, "passed")) {
    return { enabled: false, reason: "Validation must pass before publishing." };
  }

  if (!isStatus(submission.reviewStatus, "approved")) {
    return { enabled: false, reason: "Submission must be approved before publishing." };
  }

  if (isStatus(submission.status, "published")) {
    return { enabled: false, reason: "Submission is already published." };
  }

  return { enabled: true };
}

export function archiveActionState(submission: AdminSubmissionListItem): AdminActionState {
  if (isArchived(submission)) {
    return { enabled: false, reason: "Submission is already closed." };
  }

  if (isStatus(submission.status, "published")) {
    return { enabled: false, reason: "Published submissions stay in review history. Remove the listing instead." };
  }

  return { enabled: true };
}

export function removeSubmissionActionState(submission: AdminSubmissionListItem): AdminActionState {
  return archiveActionState(submission);
}

export function hideKitActionState(submission: AdminSubmissionListItem): AdminActionState {
  if (!submission.kitId) {
    return { enabled: false, reason: "No published kit is linked to this submission yet." };
  }

  if (isHiddenKit(submission)) {
    return { enabled: false, reason: "Kit is already hidden from the public catalog." };
  }

  if (!isStatus(submission.status, "published")) {
    return { enabled: false, reason: "Only published kits can be hidden." };
  }

  return { enabled: true };
}

export function unhideKitActionState(submission: AdminSubmissionListItem): AdminActionState {
  if (!submission.kitId) {
    return { enabled: false, reason: "No kit is linked to this submission." };
  }

  if (!isHiddenKit(submission)) {
    return { enabled: false, reason: "Kit is not hidden." };
  }

  return { enabled: true };
}

export function removeListingActionState(submission: AdminSubmissionListItem): AdminActionState {
  if (!submission.kitId) {
    return { enabled: false, reason: "No kit is linked to this submission." };
  }

  if (isRemovedKit(submission)) {
    return { enabled: false, reason: "Listing has already been removed." };
  }

  if (!isStatus(submission.status, "published")) {
    return { enabled: false, reason: "Only published listings can be removed." };
  }

  return { enabled: true };
}

export function isStatus(value: string | undefined, expected: string) {
  return value?.trim().toLowerCase() === expected;
}

export function isArchived(submission: AdminSubmissionListItem) {
  return (
    Boolean(submission.archivedAt) ||
    Boolean(submission.canceledAt) ||
    Boolean(submission.removedAt) ||
    isStatus(submission.status, "archived") ||
    isStatus(submission.status, "canceled") ||
    isStatus(submission.status, "removed")
  );
}

export function isHiddenKit(submission: AdminSubmissionListItem) {
  return Boolean(submission.hiddenAt) || isStatus(submission.status, "hidden") || isStatus(submission.kitStatus, "hidden");
}

export function isRemovedKit(submission: AdminSubmissionListItem) {
  return Boolean(submission.removedAt) || isStatus(submission.status, "removed") || isStatus(submission.kitStatus, "removed");
}
