import { NextResponse } from "next/server";
import { listSubmissions } from "@/lib/admin-api";
import { ForbiddenError, requireAdminForApi, UnauthorizedError } from "@/lib/auth";

const allowedQueryParams = new Set([
  "status",
  "validationStatus",
  "reviewStatus",
  "submittedByEmail",
  "submittedByUserId",
  "includeArchived",
  "includeHistory",
  "limit",
  "cursor"
]);

export async function GET(request: Request) {
  try {
    await requireAdminForApi();
    const query = safeAdminListQuery(new URL(request.url).searchParams);
    const items = await listSubmissions(query);
    return NextResponse.json({ items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin submissions request failed.";
    const status =
      error instanceof UnauthorizedError ? 401 : error instanceof ForbiddenError ? 403 : message.includes("Missing ") ? 503 : 500;
    return NextResponse.json({ message }, { status });
  }
}

function safeAdminListQuery(searchParams: URLSearchParams) {
  const query = new URLSearchParams();

  searchParams.forEach((value, key) => {
    if (allowedQueryParams.has(key) && value.trim()) {
      query.set(key, value);
    }
  });

  return query;
}
