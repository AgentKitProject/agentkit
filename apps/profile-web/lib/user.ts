import type { AgentKitUser } from "@/lib/auth/session";

export function getDisplayName(user: AgentKitUser | null | undefined) {
  if (!user) {
    return null;
  }

  const parts = [user.firstName, user.lastName].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}
