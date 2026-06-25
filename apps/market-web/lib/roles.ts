// Hosted (WorkOS) role mapping from email. Extracted from lib/auth.ts so the
// WorkOS auth provider can share it without a circular import.
import { isAdminEmail } from "@/lib/admin-emails";
import type { AgentKitMarketRole } from "@/lib/permissions";

export function getUserRole(email?: string | null): AgentKitMarketRole {
  if (!email) {
    return "anonymous";
  }

  return isAdminEmail(email) ? "admin" : "user";
}
