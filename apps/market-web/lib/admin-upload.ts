import type { AdminCreateUploadUrlRequest } from "@/lib/admin-api";

export type AdminUploadFormValues = {
  fileName: string;
  name: string;
  summary: string;
  description: string;
  version: string;
  publisherId: string;
  categories: string;
  tags: string;
};

export function buildAdminCreateUploadUrlRequest(values: AdminUploadFormValues): AdminCreateUploadUrlRequest {
  return {
    fileName: values.fileName.trim(),
    version: values.version.trim(),
    publisherId: values.publisherId.trim(),
    listingDraft: {
      name: values.name.trim(),
      summary: values.summary.trim(),
      description: values.description.trim(),
      categories: parseCommaSeparatedList(values.categories),
      tags: parseCommaSeparatedList(values.tags)
    }
  };
}

export function validateAdminCreateUploadUrlRequest(request: Partial<AdminCreateUploadUrlRequest>) {
  if (typeof request.fileName !== "string" || request.fileName.trim().length === 0) {
    return "File is required.";
  }

  if (!request.fileName.endsWith(".agentkit.zip")) {
    return "Package must be a .agentkit.zip file.";
  }

  if (typeof request.version !== "string" || request.version.trim().length === 0) {
    return "Version is required.";
  }

  if (typeof request.publisherId !== "string" || request.publisherId.trim().length === 0) {
    return "Publisher ID is required.";
  }

  if (!request.listingDraft || typeof request.listingDraft !== "object") {
    return "listingDraft is required.";
  }

  if (typeof request.listingDraft.name !== "string" || request.listingDraft.name.trim().length === 0) {
    return "Kit name is required.";
  }

  if (typeof request.listingDraft.summary !== "string" || request.listingDraft.summary.trim().length === 0) {
    return "Summary is required.";
  }

  if (!Array.isArray(request.listingDraft.categories)) {
    return "listingDraft.categories must be an array.";
  }

  if (!Array.isArray(request.listingDraft.tags)) {
    return "listingDraft.tags must be an array.";
  }

  return null;
}

export function parseCommaSeparatedList(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
