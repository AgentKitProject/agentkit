import type { AgentKitUser } from "@/lib/auth/session";

export type UserRole = "anonymous" | "user" | "admin" | "owner";

export function getUserRole(user?: AgentKitUser | null): UserRole {
  if (!user) {
    return "anonymous";
  }

  const allowlistRole = user.email ? getAllowlistedRole(user.email) : null;
  if (allowlistRole) {
    return allowlistRole;
  }

  // OIDC group claim: a self-host operator can grant admin by putting users in
  // an IdP group (ADMIN_OIDC_GROUP, e.g. Keycloak's `admins`) instead of — or
  // in addition to — the email allowlist. Mirrors market-web's admin gating.
  const adminGroup = process.env.ADMIN_OIDC_GROUP?.trim();
  if (adminGroup && (user.groups ?? []).includes(adminGroup)) {
    return "admin";
  }

  return "user";
}

export function isAdminEmail(email?: string | null) {
  return Boolean(email && getAllowlistedRole(email));
}

function getAllowlistedRole(email: string): Exclude<UserRole, "anonymous" | "user"> | null {
  const normalizedEmail = normalizeEmail(email);
  const entries = getAdminEntries();

  for (const entry of entries) {
    const [entryEmail, role = "admin"] = entry.split(":").map((part) => part.trim().toLowerCase());

    if (entryEmail === normalizedEmail) {
      return role === "owner" ? "owner" : "admin";
    }
  }

  return null;
}

function getAdminEntries() {
  return (process.env.AGENTKITPROJECT_ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}
