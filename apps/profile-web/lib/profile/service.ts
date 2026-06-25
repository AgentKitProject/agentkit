import "server-only";
import type { AgentKitUser } from "@/lib/auth/session";
import type { UserRole } from "@/lib/auth/roles";
import type { EditableProfileInput, PrivateProfile, PublicProfile } from "@/lib/profile/types";
import { joinProfileApiUrl } from "@/lib/profile/url";
import { getProfileCompleteness, normalizeEditableProfileInput } from "@/lib/profile/validation";

type ApiProfile = Partial<PrivateProfile> & Partial<PublicProfile>;
type ProfileApiErrorCode =
  | "PROFILE_API_ERROR"
  | "SERVER_CONFIG_ERROR"
  | "SERVICE_AUTH_FAILED"
  | "TRUSTED_CONTEXT_MISSING";

export class ProfileApiError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly code: ProfileApiErrorCode = "PROFILE_API_ERROR",
  ) {
    super(message);
  }
}

export async function getProfileForUser(user: AgentKitUser, role: UserRole) {
  const response = await profileFetch("/me", {
    method: "GET",
    headers: getIdentityHeaders(user, role),
  });

  return normalizePrivateProfile(await readJson<ApiProfile>(response), user, role);
}

export async function updateProfileForUser(user: AgentKitUser, role: UserRole, input: EditableProfileInput) {
  const response = await profileFetch("/me", {
    method: "PUT",
    headers: getIdentityHeaders(user, role),
    body: JSON.stringify(normalizeEditableProfileInput(input)),
  });

  return normalizePrivateProfile(await readJson<ApiProfile>(response), user, role);
}

export async function getPublicProfileByHandle(handle: string) {
  const response = await profileFetch(`/profiles/handle/${encodeURIComponent(handle)}`, {
    method: "GET",
  });

  if (response.status === 404) {
    return null;
  }

  return normalizePublicProfile(await readJson<ApiProfile>(response));
}

function normalizePrivateProfile(profile: ApiProfile, user: AgentKitUser, role: UserRole): PrivateProfile {
  const editable = normalizeEditableProfileInput({
    displayName: profile.displayName ?? "",
    handle: profile.handle ?? "",
    avatarInitials: profile.avatarInitials ?? "",
    bio: profile.bio ?? "",
    websiteUrl: profile.websiteUrl ?? "",
  });
  const completeness = getProfileCompleteness(editable);

  return {
    userId: user.id,
    email: user.email ?? "",
    role,
    verified: Boolean(profile.verified),
    ...editable,
    ...completeness,
  };
}

function normalizePublicProfile(profile: ApiProfile): PublicProfile {
  const editable = normalizeEditableProfileInput({
    displayName: profile.displayName ?? "",
    handle: profile.handle ?? "",
    avatarInitials: profile.avatarInitials ?? "",
    bio: profile.bio ?? "",
    websiteUrl: profile.websiteUrl ?? "",
  });

  return {
    ...editable,
    verified: Boolean(profile.verified),
  };
}

async function profileFetch(path: string, init: RequestInit) {
  const baseUrl = getProfileApiBaseUrl();
  const resolvedProfileApiUrl = joinProfileApiUrl(baseUrl, path);
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");

  for (const [key, value] of Object.entries(getServiceHeaders())) {
    headers.set(key, value);
  }

  logProfileApiRequest(resolvedProfileApiUrl, init.method ?? "GET", headers);

  const response = await fetch(resolvedProfileApiUrl, {
    ...init,
    cache: "no-store",
    headers,
  });

  console.info("[profile-api] response", {
    backendStatus: response.status,
  });

  if (!response.ok && response.status !== 404) {
    throw await getProfileApiError(response);
  }

  return response;
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

function getIdentityHeaders(user: AgentKitUser, role: UserRole) {
  const headers: Record<string, string> = {
    "x-agentkit-user-id": user.id,
    "x-agentkit-user-role": role,
  };

  if (user.email) {
    headers["x-agentkit-user-email"] = user.email;
  }

  return headers;
}

function getServiceHeaders() {
  const serviceKey = getProfileServiceKey();

  if (!serviceKey) {
    console.error("[profile-api] server config error", {
      hasProfileServiceKey: false,
      hasProfileApiBaseUrl: Boolean(process.env.PROFILE_API_BASE_URL),
      code: "SERVER_CONFIG_ERROR",
    });
    throw new ProfileApiError("PROFILE_SERVICE_KEY is required.", 500, "SERVER_CONFIG_ERROR");
  }

  return {
    "x-profile-service-key": serviceKey,
  };
}

function getProfileApiBaseUrl() {
  const value = process.env.PROFILE_API_BASE_URL;

  if (!value) {
    console.error("[profile-api] server config error", {
      hasProfileServiceKey: Boolean(process.env.PROFILE_SERVICE_KEY),
      hasProfileApiBaseUrl: false,
      code: "SERVER_CONFIG_ERROR",
    });
    throw new ProfileApiError("PROFILE_API_BASE_URL is required.", 500, "SERVER_CONFIG_ERROR");
  }

  try {
    return new URL(value);
  } catch {
    throw new ProfileApiError("PROFILE_API_BASE_URL must be an absolute URL.", 500, "SERVER_CONFIG_ERROR");
  }
}

async function getProfileApiError(response: Response) {
  const body = await response.clone().text().catch(() => "");

  if (response.status === 400 && body.includes("Missing trusted user context")) {
    console.error("[profile-api] trusted context rejected", {
      backendStatus: response.status,
      code: "TRUSTED_CONTEXT_MISSING",
    });
    return new ProfileApiError("TRUSTED_CONTEXT_MISSING", 502, "TRUSTED_CONTEXT_MISSING");
  }

  if (response.status === 401 || response.status === 403) {
    console.error("[profile-api] service auth failed", {
      backendStatus: response.status,
      code: "SERVICE_AUTH_FAILED",
    });
    return new ProfileApiError("SERVICE_AUTH_FAILED", 502, "SERVICE_AUTH_FAILED");
  }

  return new ProfileApiError(`Profile API request failed with status ${response.status}.`, response.status);
}

function getProfileServiceKey() {
  const rawValue = process.env.PROFILE_SERVICE_KEY?.trim();

  if (!rawValue) {
    return null;
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

    return typeof serviceKey === "string" && serviceKey.trim() ? serviceKey.trim() : null;
  } catch {
    return null;
  }
}

function logProfileApiRequest(resolvedProfileApiUrl: URL, method: string, headers: Headers) {
  const serviceKey = headers.get("x-profile-service-key");

  console.info("[profile-api] request", {
    resolvedProfileApiUrl: resolvedProfileApiUrl.toString(),
    method,
    hasProfileServiceKey: Boolean(serviceKey),
    serviceKeyLength: serviceKey?.length ?? 0,
    hasProfileApiBaseUrl: Boolean(process.env.PROFILE_API_BASE_URL),
    userIdPresent: Boolean(headers.get("x-agentkit-user-id")),
    emailPresent: Boolean(headers.get("x-agentkit-user-email")),
  });
}
