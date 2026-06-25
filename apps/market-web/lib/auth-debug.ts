import { getAppUrl, getWorkOSRedirectUri, UrlConfigError } from "@/lib/url-config";

type AuthDebugDetails = Record<string, boolean | number | string | null | undefined>;

export function logAuthDebug(event: string, details: AuthDebugDetails = {}) {
  console.log(`[agentkitmarket-auth] ${event}`, sanitizeDetails(details));
}

export function logAuthError(event: string, error: unknown, details: AuthDebugDetails = {}) {
  if (isDynamicServerUsageError(error)) {
    return;
  }

  console.error(`[agentkitmarket-auth] ${event}`, {
    ...sanitizeDetails(details),
    error: getSafeError(error)
  });
}

export function isDynamicServerUsageError(error: unknown) {
  return error instanceof Error && error.message.includes("Dynamic server usage:");
}

export function getAuthRuntimeDiagnostics() {
  const cookiePassword = process.env.WORKOS_COOKIE_PASSWORD ?? "";
  const diagnostics = {
    appUrl: getSafeConfiguredUrl(getAppUrl),
    workosRedirectUri: getSafeConfiguredUrl(getWorkOSRedirectUri),
    hasWorkOSApiKey: Boolean(process.env.WORKOS_API_KEY),
    hasWorkOSClientId: Boolean(process.env.WORKOS_CLIENT_ID),
    hasCookiePassword: Boolean(cookiePassword),
    cookiePasswordLength: cookiePassword.length,
    cookiePasswordValidLength: cookiePassword.length >= 32,
    cookieDomain: process.env.WORKOS_COOKIE_DOMAIN || null,
    cookieSameSite: process.env.WORKOS_COOKIE_SAMESITE || "lax",
    cookieName: process.env.WORKOS_COOKIE_NAME || "wos-session"
  };

  return diagnostics;
}

function getSafeConfiguredUrl(getter: () => string) {
  try {
    return getter();
  } catch (error) {
    if (error instanceof UrlConfigError) {
      return `config-error: ${error.message}`;
    }

    return "config-error";
  }
}

function sanitizeDetails(details: AuthDebugDetails) {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
}

function getSafeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return {
    name: "UnknownError",
    message: String(error)
  };
}
