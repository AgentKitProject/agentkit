import { NextResponse } from "next/server";
import { createUploadUrl, AdminApiError, type AdminCreateUploadUrlRequest } from "@/lib/admin-api";
import { validateAdminCreateUploadUrlRequest } from "@/lib/admin-upload";
import { ForbiddenError, requireAdminForApi, UnauthorizedError } from "@/lib/auth";

export async function POST(request: Request) {
  try {
    await requireAdminForApi();

    const payload = (await request.json()) as Partial<AdminCreateUploadUrlRequest>;
    const validationError = validateAdminCreateUploadUrlRequest(payload);

    if (validationError) {
      return NextResponse.json({ message: validationError }, { status: 400 });
    }

    const result = await createUploadUrl(payload as AdminCreateUploadUrlRequest);
    return NextResponse.json(result);
  } catch (error) {
    return adminErrorResponse(error);
  }
}

function adminErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Admin API request failed.";
  const status =
    error instanceof UnauthorizedError
      ? 401
      : error instanceof ForbiddenError
        ? 403
        : error instanceof AdminApiError && error.status
          ? error.status
          : message.includes("Missing ")
            ? 503
            : 500;
  return NextResponse.json({ message }, { status });
}
