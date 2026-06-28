// Pre-signup email-invite claim. On a user's first login we claim any pending
// org invites that were addressed to their email (before they had a userId),
// turning them into real memberships. Best-effort and server-side only: it uses
// the admin-keyed backend (never the browser) and must NEVER fail login.
import { claimInvitesRequestSchema, marketBackendOrgRoutes } from "@agentkitforge/contracts";
import { fetchAdminBackend } from "@/lib/admin-api";

/**
 * Claim any pending email invites for `email` into memberships for `userId`.
 * Idempotent on the backend (a no-op when there are no pending invites), so it is
 * safe to call on every login. Swallows all errors and logs them — the caller's
 * auth flow must continue regardless.
 */
export async function claimPendingEmailInvites(userId: string, email: string | undefined): Promise<void> {
  if (!userId || !email) {
    return;
  }
  const parsed = claimInvitesRequestSchema.safeParse({ email });
  if (!parsed.success) {
    return;
  }
  try {
    const response = await fetchAdminBackend(marketBackendOrgRoutes.adminClaimInvites(userId), {
      method: "POST",
      body: JSON.stringify(parsed.data)
    });
    if (!response.ok) {
      console.error("[agentkitmarket] claim-invites backend error", {
        userId,
        status: response.status
      });
    }
  } catch (error) {
    console.error("[agentkitmarket] claim-invites failed", {
      userId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
