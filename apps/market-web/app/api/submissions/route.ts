import { NextResponse } from "next/server";
import { listSubmissions } from "@/lib/admin-api";
import { ForbiddenError, requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { filterOwnSubmissions, sanitizeUserSubmissionListItem } from "@/lib/user-submissions";

export async function GET() {
  try {
    const user = await requireUserForApi();
    const items = filterOwnSubmissions(await listSubmissions("includeHistory=true"), user).map(sanitizeUserSubmissionListItem);
    return NextResponse.json({ items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Submissions request failed.";
    const status =
      error instanceof UnauthorizedError ? 401 : error instanceof ForbiddenError ? 403 : message.includes("Missing ") ? 503 : 500;
    return NextResponse.json({ message }, { status });
  }
}
