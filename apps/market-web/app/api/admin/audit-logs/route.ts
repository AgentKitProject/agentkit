import { NextResponse } from "next/server";
import { marketBackendAuditRoutes } from "@agentkitforge/contracts";
import { fetchAdminBackend } from "@/lib/admin-api";
import { ForbiddenError, requireAdminForApi, UnauthorizedError } from "@/lib/auth";

const allowedQueryParams = new Set([
  "actorUserId",
  "targetType",
  "targetId",
  "action",
  "since",
  "until",
  "limit",
  "nextToken"
]);

export async function GET(request: Request) {
  try {
    await requireAdminForApi();

    const incomingParams = new URL(request.url).searchParams;
    const forwardParams = new URLSearchParams();

    incomingParams.forEach((value, key) => {
      if (allowedQueryParams.has(key) && value.trim()) {
        forwardParams.set(key, value);
      }
    });

    const backendPath = marketBackendAuditRoutes.adminListAuditLogs();
    const qs = forwardParams.toString();
    const response = await fetchAdminBackend(`${backendPath}${qs ? `?${qs}` : ""}`);

    if (!response.ok) {
      const message = await responseErrorMessage(response);
      return NextResponse.json({ message }, { status: response.status });
    }

    const payload = await response.json();
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin audit-logs request failed.";
    const status =
      error instanceof UnauthorizedError ? 401 : error instanceof ForbiddenError ? 403 : 500;
    return NextResponse.json({ message }, { status });
  }
}

async function responseErrorMessage(response: Response) {
  let message = `Admin API request failed with status ${response.status}.`;
  try {
    const payload = (await response.json()) as unknown;
    if (
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      typeof (payload as Record<string, unknown>).message === "string"
    ) {
      message = (payload as Record<string, unknown>).message as string;
    }
  } catch {
    // keep status fallback
  }
  return message;
}
