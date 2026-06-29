import { NextResponse } from "next/server";
import { AdminApiError, createUploadUrl, type UserCreateUploadUrlBackendRequest } from "@/lib/admin-api";
import { validateAdminCreateUploadUrlRequest } from "@/lib/admin-upload";
import { ForbiddenError, requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { getPublisherSnapshotForUser } from "@/lib/profile/profile-client";
import { buildUserUploadBackendRequest, type UserCreateUploadUrlRequest } from "@/lib/user-submissions";

export async function POST(request: Request) {
  try {
    const user = await requireUserForApi();
    const browserPayload = (await request.json()) as Partial<UserCreateUploadUrlRequest>;
    // Self-host without the Profile service derives the publisher name from the
    // OIDC identity (handled in getPublisherSnapshotForUser). A CONFIGURED Profile
    // that returns no display name still 409s (hosted path — user must set a name).
    const publisherSnapshot = await getPublisherSnapshotForUser(user);

    if (!publisherSnapshot.displayName) {
      return NextResponse.json(
        { message: "AgentKitProfile display name is required for Market submission." },
        { status: 409 }
      );
    }

    const payload = buildUserUploadBackendRequest(browserPayload, user, publisherSnapshot);
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
