// Hosted (WorkOS) admin allowlist: admins are determined by email membership in
// AGENTKITMARKET_ADMIN_EMAILS. Extracted from lib/auth.ts so both lib/auth.ts
// and the WorkOS auth provider can share it without a circular import.
//
// NOTE: the OIDC (self-hosted) path resolves admin separately — see
// lib/auth-provider/oidc-config.ts (ADMIN_OIDC_GROUP / ADMIN_EMAILS).
import { logAuthDebug } from "@/lib/auth-debug";

function normalizeEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function adminEmails() {
  return (process.env.AGENTKITMARKET_ADMIN_EMAILS ?? "")
    .split(",")
    .map(normalizeEmail)
    .filter((email): email is string => Boolean(email));
}

export function isAdminEmail(email: string) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    logAuthDebug("admin-allowlist-check", { email: null, allowed: false });
    return false;
  }

  const allowed = adminEmails().includes(normalizedEmail);
  logAuthDebug("admin-allowlist-check", { email: normalizedEmail, allowed });
  return allowed;
}
