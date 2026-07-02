// Runtime URL resolution (never baked at build). Mirrors agentkitmarket-app.
const LOCAL_APP_URL = "http://localhost:3000";
const LOCAL_WORKOS_REDIRECT_URI = `${LOCAL_APP_URL}/auth/callback`;

type UrlEnv = Pick<NodeJS.ProcessEnv, "NODE_ENV"> & Record<string, string | undefined>;

export class UrlConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlConfigError";
  }
}

function resolveConfiguredUrl(options: {
  env: UrlEnv;
  names: string[];
  fallback: string;
  label: string;
}): string {
  for (const name of options.names) {
    const value = options.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return options.fallback;
}

export function getAppUrl(env: UrlEnv = process.env) {
  return resolveConfiguredUrl({
    env,
    names: ["APP_URL", "NEXT_PUBLIC_APP_URL"],
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
