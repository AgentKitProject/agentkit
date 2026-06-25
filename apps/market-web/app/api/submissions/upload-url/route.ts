import { NextResponse } from "next/server";
import { AdminApiError, createUploadUrl, type UserCreateUploadUrlBackendRequest } from "@/lib/admin-api";
import { validateAdminCreateUploadUrlRequest } from "@/lib/admin-upload";
import { ForbiddenError, requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { getPublicProfileForUser } from "@/lib/profile/profile-client";
import { buildUserUploadBackendRequest, type UserCreateUploadUrlRequest } from "@/lib/user-submissions";

export async function POST(request: Request) {
  try {
    const user = await requireUserForApi();
    const browserPayload = (await request.json()) as Partial<UserCreateUploadUrlRequest>;
    const publisherSnapshot = await getPublicProfileForUser(user.id);

    // Self-host fallback: when no Profile service is configured (PROFILE_API_BASE_URL
    // unset, e.g. OIDC self-host), there is no display name to fetch, so derive the
    // publisher name from the authenticated OIDC identity instead of 409ing. A
    // configured Profile service that returns no displayName still 409s (hosted path).
    let displayName = publisherSnapshot.displayName;
    if (!displayName && !process.env.PROFILE_API_BASE_URL) {
      displayName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email;
    }

    if (!displayName) {
      return NextResponse.json(
        { message: "AgentKitProfile display name is required for Market submission." },
        { status: 409 }
      );
    }

    const payload = buildUserUploadBackendRequest(browserPayload, user, { ...publisherSnapshot, displayName });
    const validationError = validateAdminCreateUploadUrlRequest(payload);

    if (validationError) {
      return NextResponse.json({ message: validationError }, { status: 400 });
    }

    const result = await createUploadUrl(payload as UserCreateUploadUrlBackendRequest);
    return NextResponse.json(result);
  } catch (error) {
    return userSubmissionErrorResponse(error, "Submission upload URL request failed.");
  }
}

function userSubmissionErrorResponse(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  const status =
    error instanceof UnauthorizedError
      ? 401
      : error instanceof ForbiddenError
        ? 403
        : error instanceof AdminApiError && error.status
          ? error.status
          : message.includes("Missing ") || message.includes("configuration")
            ? 503
            : 500;

  return NextResponse.json({ message }, { status });
}
