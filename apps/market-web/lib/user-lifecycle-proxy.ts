import { NextResponse } from "next/server";
import { AdminConfigError, fetchAdminBackend, getAdminConfigStatus } from "@/lib/admin-api";
import { ForbiddenError, requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { buildUserLifecycleRequest } from "@/lib/user-submissions";

type UserPostProxyOptions = {
  route: string;
  backendPath: string;
};

export async function proxyUserLifecyclePost({ route, backendPath }: UserPostProxyOptions) {
  try {
    const user = await requireUserForApi();
    const backendResponse = await fetchAdminBackend(backendPath, {
      method: "POST",
      body: JSON.stringify(buildUserLifecycleRequest(user))
    });
    const bodyText = await backendResponse.text();
    const payload = parseBackendJson(bodyText);

    if (!backendResponse.ok) {
      logUserProxyFailure({
        route,
        backendPath,
        backendStatus: backendResponse.status,
        backendSnippet: safeSnippet(bodyText),
        reason: "backend-error"
      });
    }

    if (!payload) {
      if (backendResponse.status === 204 || bodyText.length === 0) {
        return NextResponse.json({}, { status: backendResponse.status });
      }

      logUserProxyFailure({
        route,
        backendPath,
        backendStatus: backendResponse.status,
        backendSnippet: safeSnippet(bodyText),
        reason: "invalid-json"
      });
      return NextResponse.json(
        { code: "BACKEND_UNAVAILABLE", message: "Market backend returned an invalid response." },
        { status: 502 }
      );
    }

    return NextResponse.json(payload, { status: backendResponse.status });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ code: "NOT_SIGNED_IN", message: error.message }, { status: 401 });
    }

    if (error instanceof ForbiddenError) {
      return NextResponse.json({ code: "FORBIDDEN", message: error.message }, { status: 403 });
    }

    if (error instanceof AdminConfigError) {
      logUserProxyFailure({
        route,
        backendPath,
        backendStatus: null,
        backendSnippet: null,
        reason: "server-config"
      });
      return NextResponse.json({ code: "SERVER_CONFIG_ERROR", message: error.message }, { status: 500 });
    }

    logUserProxyFailure({
      route,
      backendPath,
      backendStatus: null,
      backendSnippet: error instanceof Error ? error.message : String(error),
      reason: "backend-unavailable"
    });
    return NextResponse.json({ code: "BACKEND_UNAVAILABLE", message: "Market backend is unavailable." }, { status: 502 });
  }
}

function parseBackendJson(bodyText: string) {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
}

function logUserProxyFailure({
  route,
  backendPath,
  backendStatus,
  backendSnippet,
  reason
}: {
  route: string;
  backendPath: string;
  backendStatus: number | null;
  backendSnippet: string | null;
  reason: string;
}) {
  const config = getAdminConfigStatus();

  console.error("[agentkitmarket-user] lifecycle proxy failure", {
    route,
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
