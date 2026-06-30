// Thin re-exports over the SELECTED auth provider (see lib/auth-provider/).
//
// AgentKitProfile's web tier consumes only the abstract `AgentKitUser`. The
// concrete backend (WorkOS/AuthKit for the hosted SaaS, or a generic OIDC
// provider for self-hosted) is selected by `AUTH_PROVIDER`; the pages / API
// routes here are unaffected by which provider is active.
//
// Admin gating is unchanged: `getUserRole(user)` (lib/auth/roles.ts) resolves
// admin/owner from the AGENTKITPROJECT_ADMIN_EMAILS allowlist by email — and
// both providers populate `user.email`, so admin works on either path.
import { redirect } from "next/navigation";
import { getAuthProvider } from "@/lib/auth-provider";
import { getUserRole } from "@/lib/auth/roles";
import type { AgentKitUser } from "@/lib/auth-provider/types";

export type { AgentKitUser } from "@/lib/auth-provider/types";

export async function getCurrentUser(): Promise<AgentKitUser | null> {
  return (await getAuthProvider()).getCurrentUser();
}

export async function requireUser(returnTo?: string): Promise<AgentKitUser> {
  return (await getAuthProvider()).requireUser(returnTo);
}

export async function requireAdmin() {
  const user = await requireUser();
  const role = getUserRole(user);

  if (role !== "admin" && role !== "owner") {
    redirect("/unauthorized");
  }

  return { user, role };
}
