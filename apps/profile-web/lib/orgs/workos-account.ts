import "server-only";

/**
 * Resolve a member-invite email → WorkOS user id, so the org members panel can
 * accept an email address and either add an existing user directly or store a
 * pending invite. Ported from market-web's `forge-account.ts`; uses the WorkOS
 * REST API directly (no SDK dependency) with the server-only `WORKOS_API_KEY`.
 */

export class WorkOsAccountError extends Error {
  readonly code: "ACCOUNT_CONFIG_ERROR" | "ACCOUNT_LOOKUP_FAILED";

  constructor(code: WorkOsAccountError["code"], message: string) {
    super(message);
    this.name = "WorkOsAccountError";
    this.code = code;
  }
}

/**
 * Resolve a (trimmed, lowercased) email address to a WorkOS user id.
 * Returns undefined if no registered user has that email.
 * Throws if the API key is missing or the request fails.
 */
export async function resolveWorkOsUserIdByEmail(email: string): Promise<string | undefined> {
  const apiKey = process.env.WORKOS_API_KEY;

  if (!apiKey) {
    throw new WorkOsAccountError(
      "ACCOUNT_CONFIG_ERROR",
      "AgentKitProject account verification is not configured.",
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
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch {
    throw new WorkOsAccountError("ACCOUNT_LOOKUP_FAILED", "AgentKitProject account lookup failed.");
  }

  if (!response.ok) {
    throw new WorkOsAccountError("ACCOUNT_LOOKUP_FAILED", "AgentKitProject account lookup failed.");
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
