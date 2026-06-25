// Thin re-exports over the SELECTED auth provider (see lib/auth-provider/).
//
// AgentKitMarket's browser tier consumes only the abstract `CurrentUser`. The
// concrete backend (WorkOS/AuthKit for the hosted SaaS, or a generic OIDC
// provider for self-hosted) is selected by `AUTH_PROVIDER`; the ~35 routes /
// pages here are unaffected by which provider is active.
//
// Admin gating: the hosted path determines `role` by email membership in
// AGENTKITMARKET_ADMIN_EMAILS (lib/admin-emails.ts → lib/roles.ts); the OIDC
// path determines it from an OIDC group claim (ADMIN_OIDC_GROUP) or an
// ADMIN_EMAILS allowlist (lib/auth-provider/oidc-config.ts). Either way the role
// arrives on `CurrentUser.role`, and the permission helpers below are unchanged.
import { redirect } from "next/navigation";
import { getAuthProvider } from "@/lib/auth-provider";
import { canReviewSubmission, type AgentKitMarketRole } from "@/lib/permissions";
import type { CurrentUser } from "@/lib/auth-provider/types";

export {
  canDownloadKit,
  canPublishKit,
  canReviewSubmission,
  canSubmitKit,
  canViewKit,
  isAdminRole
} from "@/lib/permissions";
export { isAdminEmail } from "@/lib/admin-emails";
export { getUserRole } from "@/lib/roles";
export type { CurrentUser } from "@/lib/auth-provider/types";
export { UnauthorizedError } from "@/lib/auth-provider/types";

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  return (await getAuthProvider()).getCurrentUser();
}

export async function requireUser(): Promise<CurrentUser> {
  return (await getAuthProvider()).requireUser();
}

export async function requireUserForApi(): Promise<CurrentUser> {
  return (await getAuthProvider()).requireUserForApi();
}

export async function requireAdmin() {
  const user = await requireUser();

  if (!canReviewSubmission(user)) {
    redirect("/admin/unauthorized");
  }

  return user;
}

export async function requireAdminForApi() {
  const user = await requireUserForApi();

  if (!canReviewSubmission(user)) {
    throw new ForbiddenError("Admin access is required.");
  }

  return user;
}

export function getUserEmail(user?: Pick<CurrentUser, "email"> | null) {
  return user?.email ?? null;
}

// Re-exported for callers that need the role type alongside the user model.
export type { AgentKitMarketRole };
