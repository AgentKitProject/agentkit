import {
  forgeUploadBackendRequestSchema,
  type ForgeUploadBackendRequest,
  type ListingDraft
} from "@agentkitforge/contracts";
import type { ListingDraftInput } from "@/lib/admin-api";
import type { PublisherSnapshot } from "@/lib/profile/types";

// The backend payload and listing draft shapes are owned by the shared
// contracts package; re-export them so existing consumers keep their imports.
export type { ForgeUploadBackendRequest, ListingDraft };

export type ForgeUploadUrlRequest = {
  fileName?: unknown;
  version?: unknown;
  listingDraft?: Partial<ListingDraftInput> | unknown;
  publisherId?: unknown;
  kitId?: unknown;
  slug?: unknown;
  kitSlug?: unknown;
  submittedByUserId?: unknown;
  submittedByEmail?: unknown;
  publisherSnapshot?: unknown;
};

export function buildForgeUploadBackendRequest({
  request,
  userId,
  email,
  publisherSnapshot
}: {
  request: ForgeUploadUrlRequest;
  userId: string;
  email?: string;
  publisherSnapshot: PublisherSnapshot;
}): ForgeUploadBackendRequest {
  const listingDraft = isRecord(request.listingDraft) ? request.listingDraft : {};
  const payload: ForgeUploadBackendRequest = {
    fileName: stringValue(request.fileName),
    version: stringValue(request.version),
    publisherId: profileDisplayNameAsPublisherId(publisherSnapshot.displayName),
    submittedByUserId: userId,
    submittedByEmail: stringValue(email),
    listingDraft: {
      name: stringValue(listingDraft.name),
      summary: stringValue(listingDraft.summary),
      description: stringValue(listingDraft.description),
      categories: arrayValue(listingDraft.categories),
      tags: arrayValue(listingDraft.tags)
    }
  };

  if (hasPublisherSnapshot(publisherSnapshot)) {
    payload.publisherSnapshot = publisherSnapshot;
  }

  return payload;
}

export function validateForgeUploadBackendRequest(request: ForgeUploadBackendRequest) {
  if (!request.fileName) {
    return "File is required.";
  }

  if (!request.fileName.endsWith(".agentkit.zip")) {
    return "Package must be a .agentkit.zip file.";
  }

  if (!request.version) {
    return "Version is required.";
  }

  if (!request.publisherId) {
    return "AgentKitProfile display name is required for Market submission.";
  }

  if (!request.submittedByUserId) {
    return "Forge authentication token is missing a user id.";
  }

  if (!request.submittedByEmail) {
    return "AgentKitProject account email is required for Market submission.";
  }

  if (!request.listingDraft.name) {
    return "Kit name is required.";
  }

  if (!request.listingDraft.summary) {
    return "Summary is required.";
  }

  if (!Array.isArray(request.listingDraft.categories)) {
    return "listingDraft.categories must be an array.";
  }

  if (!Array.isArray(request.listingDraft.tags)) {
    return "listingDraft.tags must be an array.";
  }

  // Final guard: the outgoing payload must satisfy the shared cross-repo
  // contract. The user-friendly checks above should catch anything first.
  const contractCheck = forgeUploadBackendRequestSchema.safeParse(request);

  if (!contractCheck.success) {
    return "Submission payload does not match the Market backend contract.";
  }

  return null;
}

function hasPublisherSnapshot(snapshot: PublisherSnapshot) {
  return Boolean(snapshot.displayName || snapshot.handle || snapshot.avatarInitials || snapshot.verified);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function profileDisplayNameAsPublisherId(displayName?: string | null) {
  return displayName?.trim() ?? "";
}
