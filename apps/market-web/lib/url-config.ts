const LOCAL_APP_URL = "http://localhost:3000";
const LOCAL_WORKOS_REDIRECT_URI = `${LOCAL_APP_URL}/auth/callback`;

type UrlEnv = Pick<NodeJS.ProcessEnv, "NODE_ENV"> & Record<string, string | undefined>;

export class UrlConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlConfigError";
  }
}

export function getAppUrl(env: UrlEnv = process.env) {
  return resolveConfiguredUrl({
    env,
    names: ["APP_URL", "NEXT_PUBLIC_APP_URL"],
    fallback: LOCAL_APP_URL,
    label: "APP_URL"
  });
}

export function getSignOutReturnUrl(env: UrlEnv = process.env) {
  return resolveConfiguredUrl({
    env,
    names: ["APP_URL"],
    fallback: LOCAL_APP_URL,
    label: "APP_URL"
  });
}

export function getWorkOSRedirectUri(env: UrlEnv = process.env) {
  return resolveConfiguredUrl({
    env,
    names: ["WORKOS_REDIRECT_URI", "NEXT_PUBLIC_WORKOS_REDIRECT_URI"],
    fallback: LOCAL_WORKOS_REDIRECT_URI,
    label: "WORKOS_REDIRECT_URI"
  });
}

export function resolveAuthReturnTo(rawReturnTo: string | null, appUrl: string) {
  const candidate = rawReturnTo?.trim() || "/";
  const appOrigin = new URL(appUrl).origin;

  if (candidate.startsWith("/") && !candidate.startsWith("//")) {
    return new URL(candidate, appOrigin).toString();
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new UrlConfigError("Invalid sign-in return URL.");
  }

  if (parsed.origin === appOrigin) {
    return parsed.toString();
  }

  throw new UrlConfigError("Sign-in return URL must stay on AgentKitMarket.");
}

function resolveConfiguredUrl({
  env,
  names,
  fallback,
  label
}: {
  env: UrlEnv;
  names: string[];
  fallback: string;
  label: string;
}) {
  const value = names.map((name) => env[name]?.trim()).find(Boolean);

  if (!value) {
    if (isProduction(env)) {
      throw new UrlConfigError(`${label} is required in production.`);
    }

    return fallback;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UrlConfigError(`${label} must be an absolute URL.`);
  }

  if (isProduction(env) && value.includes("localhost")) {
    throw new UrlConfigError(`${label} must not use localhost in production.`);
  }

  return parsed.toString().replace(/\/$/, "");
}

function isProduction(env: UrlEnv) {
  return env.NODE_ENV === "production";
}
