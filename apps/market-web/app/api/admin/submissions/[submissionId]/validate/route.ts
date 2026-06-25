import { NextResponse } from "next/server";
import { startValidation } from "@/lib/admin-api";
import { ForbiddenError, requireAdminForApi, UnauthorizedError } from "@/lib/auth";

export async function POST(_request: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  try {
    await requireAdminForApi();

    const { submissionId } = await params;
    const result = await startValidation(submissionId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Validation request failed.";
    const status =
      error instanceof UnauthorizedError ? 401 : error instanceof ForbiddenError ? 403 : message.includes("Missing ") ? 503 : 500;
    return NextResponse.json({ message }, { status });
  }
}
