import { NextResponse } from "next/server";
import { AdminApiError, getSubmissionById, startValidation } from "@/lib/admin-api";
import { ForbiddenError, requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { isOwnSubmission } from "@/lib/user-submissions";

type RouteContext = {
  params: Promise<{ submissionId?: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  try {
    const user = await requireUserForApi();
    const { submissionId } = await params;

    if (!submissionId) {
      return NextResponse.json({ code: "BAD_REQUEST", message: "Missing submissionId." }, { status: 400 });
    }

    const item = await getSubmissionById(submissionId);

    if (!item || !isOwnSubmission(item, user)) {
      return NextResponse.json({ code: "NOT_FOUND", message: "Submission not found." }, { status: 404 });
    }

    const result = await startValidation(submissionId);
    return NextResponse.json(result);
  } catch (error) {
    return userSubmissionErrorResponse(error, "Validation queue request failed.");
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
