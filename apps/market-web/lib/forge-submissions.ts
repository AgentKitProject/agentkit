import { NextResponse } from "next/server";
import { marketBackendRoutes } from "@agentkitforge/contracts";
import {
  AdminApiError,
  fetchAdminBackend,
  getSubmissionById,
  startValidation,
  type AdminCreateUploadUrlResponse
} from "@/lib/admin-api";
import { resolveForgeSubmissionAccount } from "@/lib/forge-account";
import { requireForgeUser, type ForgeAuthenticatedUser } from "@/lib/forge-auth";
import {
  buildForgeUploadBackendRequest,
  validateForgeUploadBackendRequest,
  type ForgeUploadUrlRequest
} from "@/lib/forge-submission-payload";
import { getPublicProfileForUser } from "@/lib/profile/profile-client";
import { forgeSubmissionError, forgeSubmissionException, logForgeSubmissionFailure, mapBackendError } from "@/lib/forge-route-errors";
import { isOwnSubmission, type SubmissionUser } from "@/lib/user-submissions";

export async function createForgeUploadUrl(request: Request) {
  try {
    const forgeUser = await requireForgeUser(request);
    const forgePayload = (await request.json()) as ForgeUploadUrlRequest;
    const submissionUser = await resolveForgeSubmissionAccount(forgeUser);
    const publisherSnapshot = await getPublicProfileForUser(submissionUser.id);
    const payload = buildForgeUploadBackendRequest({
      request: forgePayload,
      userId: submissionUser.id,
      email: submissionUser.email,
      publisherSnapshot
    });
    const validationError = validateForgeUploadBackendRequest(payload);

    if (validationError) {
      return forgeSubmissionError("BAD_REQUEST", validationError, 400);
    }

    return postForgeBackendUploadUrl(payload);
  } catch (error) {
    return forgeSubmissionException(error, "/api/forge/submissions/upload-url");
  }
}

export async function validateForgeSubmission(request: Request, submissionId?: string) {
  try {
    const forgeUser = await requireForgeUser(request);
    const submissionUser = forgeSubmissionUser(forgeUser);

    if (!submissionId) {
      return forgeSubmissionError("BAD_REQUEST", "Missing submissionId.", 400);
    }

    const item = await getSubmissionById(submissionId);

    if (!item) {
      return forgeSubmissionError("NOT_FOUND", "Submission not found.", 404);
    }

    if (!isOwnSubmission(item, submissionUser)) {
      return forgeSubmissionError("FORBIDDEN", "You do not have permission.", 403);
    }

    const result = await startValidation(submissionId);
    return NextResponse.json(result);
  } catch (error) {
    return forgeSubmissionException(error, `/api/forge/submissions/${submissionId ?? ""}/validate`);
  }
}

export { forgeSubmissionError, forgeSubmissionException } from "@/lib/forge-route-errors";

export function forgeSubmissionUser(user: ForgeAuthenticatedUser): SubmissionUser {
  return {
    id: user.id,
    email: user.email ?? ""
  };
}

async function postForgeBackendUploadUrl(payload: unknown) {
  const backendPath = marketBackendRoutes.adminCreateUploadUrl();
  const backendResponse = await fetchAdminBackend(backendPath, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const bodyText = await backendResponse.text();
  const responsePayload = parseBackendJson(bodyText);

  if (!responsePayload) {
    logForgeSubmissionFailure({
      backendPath,
      backendStatus: backendResponse.status,
      backendSnippet: safeSnippet(bodyText),
      reason: "invalid-json"
    });
    return forgeSubmissionError("MARKET_BACKEND_ERROR", "AgentKitMarket could not complete the request.", 500);
  }

  if (!backendResponse.ok) {
    logForgeSubmissionFailure({
      backendPath,
      backendStatus: backendResponse.status,
      backendSnippet: safeSnippet(bodyText),
      reason: "backend-error"
    });
    return mapBackendError(backendResponse.status, backendErrorMessage(responsePayload));
  }

  return NextResponse.json(normalizeUploadResponse(responsePayload), { status: backendResponse.status });
}

function normalizeUploadResponse(payload: unknown): AdminCreateUploadUrlResponse {
  const source = isRecord(payload) ? payload : {};

  return {
    submissionId: requiredString(source.submissionId, "submissionId"),
    uploadUrl: requiredString(source.uploadUrl ?? source.url, "uploadUrl"),
    method: source.method === "POST" ? "POST" : "PUT",
    fields: stringRecord(source.fields),
    headers: stringRecord(source.headers)
  };
}

function backendErrorMessage(payload: unknown) {
  if (isRecord(payload) && typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }

  return "AgentKitMarket could not complete the request.";
}

function parseBackendJson(bodyText: string) {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdminApiError(`Upload response is missing ${label}.`, 500);
  }

  return value;
}

function stringRecord(value: unknown) {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function safeSnippet(value: string) {
  return value.slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
