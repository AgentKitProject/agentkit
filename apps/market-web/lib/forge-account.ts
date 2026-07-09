import type { ForgeAuthenticatedUser } from "@/lib/forge-auth";

export type ForgeSubmissionAccount = {
  id: string;
  email: string;
};

export class ForgeAccountError extends Error {
  readonly code: "ACCOUNT_CONFIG_ERROR" | "ACCOUNT_LOOKUP_FAILED" | "ACCOUNT_EMAIL_MISSING";
  readonly status: number;

  constructor(code: ForgeAccountError["code"], message: string, status: number) {
    super(message);
    this.name = "ForgeAccountError";
    this.code = code;
    this.status = status;
  }
}

export async function resolveForgeSubmissionAccount(user: ForgeAuthenticatedUser): Promise<ForgeSubmissionAccount> {
  // Under AUTH_PROVIDER=oidc (self-host + Keycloak-migrated hosted) there is no
  // WorkOS user-management API (WORKOS_API_KEY is gone). The OIDC bearer already
  // carries the verified `email` claim (requireForgeOidcUser sets user.email), so
  // trust it directly — same as the browser submit path. Only the hosted WorkOS
  // token (no email claim on the bearer) re-fetches the account from WorkOS.
  const email = isForgeOidcProvider()
    ? optionalString(user.email)
    : optionalString((await getWorkOsUser(user.id)).email);

  if (!email) {
    throw new ForgeAccountError(
      "ACCOUNT_EMAIL_MISSING",
      "AgentKitProject account email is required for Market submission.",
      409
    );
  }

  return {
    id: user.id,
    email
  };
}

// Mirrors lib/forge-auth.ts:isForgeOidcProvider (AUTH_PROVIDER=oidc, case/space-
// insensitive). Inlined here so this WorkOS-bound module never transitively loads
// the OIDC provider deps.
function isForgeOidcProvider(): boolean {
  return (process.env.AUTH_PROVIDER ?? "").trim().toLowerCase() === "oidc";
}

async function getWorkOsUser(userId: string) {
  const apiKey = process.env.WORKOS_API_KEY;

  if (!apiKey) {
    throw new ForgeAccountError(
      "ACCOUNT_CONFIG_ERROR",
      "AgentKitMarket account verification is not configured.",
      500
    );
  }

  let response: Response;

  try {
    response = await fetch(`${getWorkOsApiOrigin()}/user_management/users/${encodeURIComponent(userId)}`, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
      }
    });
  } catch {
    throw new ForgeAccountError(
      "ACCOUNT_LOOKUP_FAILED",
      "AgentKitProject account could not be verified for Market submission.",
      502
    );
  }

  if (!response.ok) {
    throw new ForgeAccountError(
      "ACCOUNT_LOOKUP_FAILED",
      "AgentKitProject account could not be verified for Market submission.",
      response.status === 404 ? 401 : 502
    );
  }

  return (await response.json()) as { email?: unknown };
}

/**
 * Resolve a (trimmed, lowercased) email address to a WorkOS user id.
 * Returns undefined if no registered user has that email.
 * Throws if the API key is missing or the request fails.
 */
export async function resolveWorkOsUserIdByEmail(email: string): Promise<string | undefined> {
  const apiKey = process.env.WORKOS_API_KEY;

  if (!apiKey) {
    throw new ForgeAccountError(
      "ACCOUNT_CONFIG_ERROR",
      "AgentKitMarket account verification is not configured.",
      500
    );
  }

  const normalizedEmail = email.trim().toLowerCase();
  const url = `${getWorkOsApiOrigin()}/user_management/users?email=${encodeURIComponent(normalizedEmail)}&limit=1`;

  let response: Response;

  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
      }
    });
  } catch {
    throw new ForgeAccountError(
      "ACCOUNT_LOOKUP_FAILED",
      "AgentKitProject account lookup failed.",
      502
    );
  }

  if (!response.ok) {
    throw new ForgeAccountError(
      "ACCOUNT_LOOKUP_FAILED",
      "AgentKitProject account lookup failed.",
      502
    );
  }

  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const firstUser = payload.data?.[0];

  if (!firstUser || typeof firstUser.id !== "string") {
    return undefined;
  }

  return firstUser.id;
}

function getWorkOsApiOrigin() {
  const protocol = process.env.WORKOS_API_HTTPS === "false" ? "http" : "https";
  const hostname = process.env.WORKOS_API_HOSTNAME || "api.workos.com";
  const port = process.env.WORKOS_API_PORT ? `:${process.env.WORKOS_API_PORT}` : "";

  return `${protocol}://${hostname}${port}`;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
