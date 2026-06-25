import { NextResponse } from "next/server";
import { AdminConfigError, fetchAdminBackend, getAdminConfigStatus } from "@/lib/admin-api";
import { ForbiddenError, requireAdminForApi, UnauthorizedError } from "@/lib/auth";

type RouteContext = {
  params: Promise<{ submissionId?: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  let submissionId: string | undefined;
  let backendPath = "";

  try {
    await requireAdminForApi();
    submissionId = (await params).submissionId;

    if (!submissionId) {
      return NextResponse.json({ code: "BAD_REQUEST", message: "Missing submissionId." }, { status: 400 });
    }

    backendPath = `/admin/submissions/${encodeURIComponent(submissionId)}`;
    const backendResponse = await fetchAdminBackend(backendPath);
    const bodyText = await backendResponse.text();
    const payload = parseBackendJson(bodyText);

    if (!payload) {
      logDetailProxyFailure({
        submissionId,
        backendPath,
        backendStatus: backendResponse.status,
        backendSnippet: safeSnippet(bodyText),
        reason: "invalid-json"
      });
      return NextResponse.json(
        { code: "BACKEND_UNAVAILABLE", message: "Admin submission backend returned an invalid response." },
        { status: 502 }
      );
    }

    if (!backendResponse.ok) {
      logDetailProxyFailure({
        submissionId,
        backendPath,
        backendStatus: backendResponse.status,
        backendSnippet: safeSnippet(bodyText),
        reason: "backend-error"
      });
    }

    return NextResponse.json(payload, { status: backendResponse.status });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ code: "UNAUTHORIZED", message: error.message }, { status: 401 });
    }

    if (error instanceof ForbiddenError) {
      return NextResponse.json({ code: "FORBIDDEN", message: error.message }, { status: 403 });
    }

    if (error instanceof AdminConfigError) {
      logDetailProxyFailure({
        submissionId,
        backendPath,
        backendStatus: null,
        backendSnippet: null,
        reason: "server-config"
      });
      return NextResponse.json({ code: "SERVER_CONFIG_ERROR", message: error.message }, { status: 503 });
    }

    logDetailProxyFailure({
      submissionId,
      backendPath,
      backendStatus: null,
      backendSnippet: error instanceof Error ? error.message : String(error),
      reason: "backend-unavailable"
    });
    return NextResponse.json(
      { code: "BACKEND_UNAVAILABLE", message: "Admin submission backend is unavailable." },
      { status: 502 }
    );
  }
}

function parseBackendJson(bodyText: string) {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
}

function logDetailProxyFailure({
  submissionId,
  backendPath,
  backendStatus,
  backendSnippet,
  reason
}: {
  submissionId?: string;
  backendPath: string;
  backendStatus: number | null;
  backendSnippet: string | null;
  reason: string;
}) {
  const config = getAdminConfigStatus();

  console.error("[agentkitmarket-admin] detail proxy failure", {
    submissionId: submissionId ?? null,
    backendPath,
    backendStatus,
    backendSnippet,
    hasApiBaseUrl: config.hasApiBaseUrl,
    hasAdminKey: config.hasAdminKey,
    reason
  });
}

function safeSnippet(value: string) {
  return value.slice(0, 500);
}
