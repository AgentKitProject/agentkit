import { NextResponse } from "next/server";
import { AdminConfigError, fetchAdminBackend, getAdminConfigStatus } from "@/lib/admin-api";
import { ForgeAuthError, requireForgeUser } from "@/lib/forge-auth";
import { normalizeKitDownloadResponse } from "@/lib/kit-download";

type RouteContext = {
  params: Promise<{ slug?: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  let slug: string | undefined;
  let backendPath = "";

  try {
    await requireForgeUser(request);
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
      logForgeDownloadFailure({
        slug,
        backendPath,
        backendStatus: backendResponse.status,
        backendSnippet: safeSnippet(bodyText),
        reason: "invalid-json"
      });
      return safeJsonError("BACKEND_UNAVAILABLE", "Download backend returned an invalid response.", 502);
    }

    if (!backendResponse.ok) {
      logForgeDownloadFailure({
        slug,
        backendPath,
        backendStatus: backendResponse.status,
        backendSnippet: safeSnippet(bodyText),
        reason: "backend-error"
      });
      return mapBackendDownloadError(backendResponse.status, payload);
    }

    return NextResponse.json({ ...normalizeKitDownloadResponse(payload), slug }, { status: backendResponse.status });
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      logForgeDownloadFailure({
        slug,
        backendPath,
        backendStatus: null,
        backendSnippet: null,
        reason: error.failureStage,
        authorizationHeaderPresent: error.authorizationHeaderPresent,
        tokenLength: error.tokenLength
      });
      if (error.code === "SERVER_CONFIG_ERROR") {
        return safeJsonError("SERVER_CONFIG_ERROR", error.message, 500);
      }

      if (error.code === "NOT_SUPPORTED") {
        return safeJsonError("FORGE_AUTH_NOT_SUPPORTED", error.message, 501);
      }

      return safeJsonError("NOT_SIGNED_IN", "AgentKitProject sign-in is required.", 401);
    }

    if (error instanceof AdminConfigError) {
      logForgeDownloadFailure({
        slug,
        backendPath,
        backendStatus: null,
        backendSnippet: null,
        reason: "server-config"
      });
      return safeJsonError("SERVER_CONFIG_ERROR", error.message, 500);
    }

    logForgeDownloadFailure({
      slug,
      backendPath,
      backendStatus: null,
      backendSnippet: error instanceof Error ? error.message : String(error),
      reason: "backend-unavailable"
    });
    return safeJsonError("BACKEND_UNAVAILABLE", "Download backend is unavailable.", 502);
  }
}

function mapBackendDownloadError(status: number, payload: unknown) {
  const backendMessage = backendErrorMessage(payload);

  if (status === 403) {
    return safeJsonError("DOWNLOAD_NOT_ALLOWED", backendMessage ?? "This kit is not available for Forge download.", 403);
  }

  if (status === 404) {
    return safeJsonError("KIT_NOT_FOUND", backendMessage ?? "Kit not found.", 404);
  }

  if (status >= 500) {
    return safeJsonError("BACKEND_UNAVAILABLE", "Download backend is unavailable.", 502);
  }

  return safeJsonError("DOWNLOAD_NOT_ALLOWED", backendMessage ?? "This kit is not available for Forge download.", status);
}

function safeJsonError(code: string, message: string, status: number) {
  return NextResponse.json({ code, error: code, message }, { status });
}

function backendErrorMessage(payload: unknown) {
  if (isRecord(payload) && typeof payload.message === "string") {
    return payload.message;
  }

  return null;
}

function parseBackendJson(bodyText: string) {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
}

function logForgeDownloadFailure({
  slug,
  backendPath,
  backendStatus,
  backendSnippet,
  reason,
  authorizationHeaderPresent,
  tokenLength
}: {
  slug?: string;
  backendPath: string;
  backendStatus: number | null;
  backendSnippet: string | null;
  reason: string;
  authorizationHeaderPresent?: boolean;
  tokenLength?: number;
}) {
  const config = getAdminConfigStatus();

  console.error("[agentkitmarket] forge download proxy failure", {
    slug: slug ?? null,
    backendPath,
    backendStatus,
    backendSnippet,
    hasApiBaseUrl: config.hasApiBaseUrl,
    hasAdminKey: config.hasAdminKey,
    authHelper: "requireForgeUser",
    authorizationHeaderPresent,
    tokenLength,
    reason
  });
}

function safeSnippet(value: string) {
  return value.slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
