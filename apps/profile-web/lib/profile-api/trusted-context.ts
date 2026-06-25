import "server-only";
import { ApiError } from "@/lib/profile-api/validation";
import type { TrustedContext } from "@/lib/profile-api/handlers";

/**
 * Trusted-context auth for the in-process /me routes, ported from the Lambda's
 * `requireTrustedContext`. Validates the inbound `x-profile-service-key` against
 * `PROFILE_SERVICE_KEY` (read directly from env — no AWS Secrets Manager) and
 * reads the `x-agentkit-user-*` headers set by `lib/profile/service.ts`.
 */

export function requireTrustedContext(request: Request): TrustedContext {
  const providedKey = request.headers.get("x-profile-service-key");
  const expectedKey = getServiceKey();

  if (!providedKey || providedKey !== expectedKey) {
    throw new ApiError(401, "Unauthorized");
  }

  const userId = request.headers.get("x-agentkit-user-id");
  if (!userId || userId.startsWith("HANDLE#")) {
    throw new ApiError(400, "Missing trusted user context");
  }

  return {
    userId,
    email: request.headers.get("x-agentkit-user-email") ?? null,
  };
}

/**
 * Reads `PROFILE_SERVICE_KEY` from env, tolerating either a raw string or a JSON
 * blob (mirrors the tolerance in `lib/profile/service.ts`, which is the outbound
 * side of the same shared secret).
 */
function getServiceKey(): string {
  const rawValue = process.env.PROFILE_SERVICE_KEY?.trim();

  if (!rawValue) {
    throw new ApiError(500, "Service key is not configured");
  }

  if (!rawValue.startsWith("{")) {
    return rawValue;
  }

  try {
    const parsed = JSON.parse(rawValue) as Record<string, unknown>;
    const serviceKey =
      parsed.serviceKey ??
      parsed.profileServiceKey ??
      parsed.PROFILE_SERVICE_KEY ??
      parsed.profile_service_key ??
      parsed.secretKey ??
      parsed.secret_key;

    if (typeof serviceKey === "string" && serviceKey.trim()) {
      return serviceKey.trim();
    }
  } catch {
    // fall through
  }

  throw new ApiError(500, "Service key is not configured");
}
