const DEFAULT_RETURN_TO = "/account";
const LOCAL_APP_URL = "http://localhost:3000";

export function getAppUrl() {
  return getRequiredUrl("APP_URL", process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL, LOCAL_APP_URL);
}

export function getAppHomeUrl() {
  return `${getAppUrl()}/`;
}

export function getWorkOSRedirectUri() {
  return getRequiredUrl("WORKOS_REDIRECT_URI", process.env.WORKOS_REDIRECT_URI, `${LOCAL_APP_URL}/auth/callback`);
}

export function safeReturnTo(returnTo?: string | null) {
  if (!returnTo) {
    return DEFAULT_RETURN_TO;
  }

  try {
    const parsed = new URL(returnTo, getAppUrl());

    if (parsed.origin !== getAppUrlOrigin()) {
      return DEFAULT_RETURN_TO;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

export function safeReturnUrl(returnTo?: string | null) {
  return new URL(safeReturnTo(returnTo), getAppUrl()).toString();
}

function getAppUrlOrigin() {
  return new URL(getAppUrl()).origin;
}

function getRequiredUrl(name: string, value: string | undefined, developmentFallback: string) {
  const isProductionRuntime =
    process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build";
  const candidate = value || (!isProductionRuntime ? developmentFallback : undefined);

  if (!candidate) {
    throw new Error(`${name} is required in production.`);
  }

  let parsed: URL;

  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }

  if (isProductionRuntime && parsed.hostname === "localhost") {
    throw new Error(`${name} cannot use localhost in production.`);
  }

  return parsed.toString().replace(/\/$/, "");
}
