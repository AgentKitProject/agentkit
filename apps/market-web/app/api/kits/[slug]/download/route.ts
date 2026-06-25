import { NextResponse } from "next/server";
import { AdminConfigError, fetchAdminBackend, getAdminConfigStatus } from "@/lib/admin-api";
import { ForbiddenError, requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { normalizeKitDownloadResponse } from "@/lib/kit-download";

type RouteContext = {
  params: Promise<{ slug?: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  let slug: string | undefined;
  let backendPath = "";

  try {
    await requireUserForApi();
    slug = (await params).slug;

    if (!slug) {
      return NextResponse.json({ code: "BAD_REQUEST", message: "Missing kit slug." }, { status: 400 });
    }

    backendPath = `/admin/kits/by-slug/${encodeURIComponent(slug)}/download-url`;
    const backendResponse = await fetchAdminBackend(backendPath, {
      method: "POST",
      body: JSON.stringify({})
    });
    const bodyText = await backendResponse.text();
    const payload = parseBackendJson(bodyText);

    if (!payload) {
      logDownloadProxyFailure({
        slug,
        backendPath,
        backendStatus: backendResponse.status,
        backendSnippet: safeSnippet(bodyText),
        reason: "invalid-json"
      });
      return NextResponse.json(
        { code: "BACKEND_UNAVAILABLE", message: "Download backend returned an invalid response." },
        { status: 502 }
      );
    }

    if (!backendResponse.ok) {
      logDownloadProxyFailure({
        slug,
        backendPath,
        backendStatus: backendResponse.status,
        backendSnippet: safeSnippet(bodyText),
        reason: "backend-error"
      });
      return NextResponse.json(payload, { status: backendResponse.status });
    }

    return NextResponse.json(normalizeKitDownloadResponse(payload), { status: backendResponse.status });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ code: "UNAUTHORIZED", message: error.message }, { status: 401 });
    }

    if (error instanceof ForbiddenError) {
      return NextResponse.json({ code: "FORBIDDEN", message: error.message }, { status: 403 });
    }

    if (error instanceof AdminConfigError) {
      logDownloadProxyFailure({
        slug,
        backendPath,
        backendStatus: null,
        backendSnippet: null,
        reason: "server-config"
      });
      return NextResponse.json({ code: "SERVER_CONFIG_ERROR", message: error.message }, { status: 503 });
    }

    logDownloadProxyFailure({
      slug,
      backendPath,
      backendStatus: null,
      backendSnippet: error instanceof Error ? error.message : String(error),
      reason: "backend-unavailable"
    });
    return NextResponse.json({ code: "BACKEND_UNAVAILABLE", message: "Download backend is unavailable." }, { status: 502 });
  }
}

function parseBackendJson(bodyText: string) {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
}

function logDownloadProxyFailure({
  slug,
  backendPath,
  backendStatus,
  backendSnippet,
  reason
}: {
  slug?: string;
  backendPath: string;
  backendStatus: number | null;
  backendSnippet: string | null;
  reason: string;
}) {
  const config = getAdminConfigStatus();

  console.error("[agentkitmarket] download proxy failure", {
    slug: slug ?? null,
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
