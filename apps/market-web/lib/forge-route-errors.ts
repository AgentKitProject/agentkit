import { AdminApiError, AdminConfigError, getAdminConfigStatus } from "./admin-api.ts";
import { ForgeAccountError } from "./forge-account.ts";
import { ForgeAuthError } from "./forge-auth.ts";

export function forgeSubmissionException(error: unknown, endpointPath: string) {
  if (error instanceof ForgeAuthError) {
    logForgeSubmissionFailure({
      backendPath: "",
      backendStatus: null,
      backendSnippet: null,
      reason: error.failureStage,
      authorizationHeaderPresent: error.authorizationHeaderPresent,
      tokenLength: error.tokenLength
    });

    if (error.code === "SERVER_CONFIG_ERROR") {
      return forgeSubmissionError("MARKET_CONFIG_ERROR", "AgentKitMarket server configuration is incomplete.", 500);
    }

    if (error.code === "NOT_SUPPORTED") {
      return forgeSubmissionError("FORGE_AUTH_NOT_SUPPORTED", error.message, 501);
    }

    return forgeAuthFailedError(error, endpointPath);
  }

  if (error instanceof AdminConfigError) {
    return forgeSubmissionError("MARKET_CONFIG_ERROR", "AgentKitMarket server configuration is incomplete.", 500);
  }

  if (error instanceof ForgeAccountError) {
    logForgeSubmissionFailure({
      backendPath: "",
      backendStatus: null,
      backendSnippet: null,
      reason: error.code
    });

    if (error.code === "ACCOUNT_CONFIG_ERROR") {
      return forgeSubmissionError("MARKET_CONFIG_ERROR", "AgentKitMarket account verification is not configured.", 500);
    }

    return forgeSubmissionError("PROFILE_INCOMPLETE", error.message, error.status);
  }

  if (error instanceof AdminApiError) {
    return mapBackendError(error.status ?? 500, error.message);
  }

  return forgeSubmissionError("MARKET_BACKEND_ERROR", "AgentKitMarket could not complete the request.", 500);
}

export function mapBackendError(status: number, message: string) {
  if (status === 400) {
    return forgeSubmissionError("BAD_REQUEST", message, 400);
  }

  if (status === 401) {
    return forgeSubmissionError("MARKET_BACKEND_UNAUTHORIZED", message || "Market backend rejected the service request.", 401);
  }

  if (status === 403) {
    return forgeSubmissionError("FORBIDDEN", "You do not have permission.", 403);
  }

  if (status === 404) {
    return forgeSubmissionError("NOT_FOUND", "Submission not found.", 404);
  }

  if (status === 409) {
    return forgeSubmissionError("CONFLICT", message, 409);
  }

  return forgeSubmissionError("MARKET_BACKEND_ERROR", message, status >= 500 ? 500 : status);
}

export function forgeSubmissionError(code: string, message: string, status: number) {
  return Response.json({ code, error: code, message }, { status });
}

function forgeAuthFailedError(error: ForgeAuthError, endpointPath: string) {
  return Response.json(
    {
      code: "FORGE_AUTH_FAILED",
      error: "FORGE_AUTH_FAILED",
      message: "Forge device-auth token was not accepted by AgentKitMarket.",
      diagnostics: {
        endpointPath,
        authorizationHeaderPresent: error.authorizationHeaderPresent,
        tokenLength: error.tokenLength,
        authHelper: "requireForgeUser",
        failureStage: error.failureStage
      }
    },
    { status: 401 }
  );
}

export function logForgeSubmissionFailure({
  backendPath,
  backendStatus,
  backendSnippet,
  reason,
  authorizationHeaderPresent,
  tokenLength
}: {
  backendPath: string;
  backendStatus: number | null;
  backendSnippet: string | null;
  reason: string;
  authorizationHeaderPresent?: boolean;
  tokenLength?: number;
}) {
  const config = getAdminConfigStatus();

  console.error("[agentkitmarket] forge submission proxy failure", {
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
