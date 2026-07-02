// /forge — the web Forge UI entry. Server component: enforces an authenticated
// session (Web Forge is logged-in by design), then mounts the client ForgeApp
// which talks to /api/* through the WebForgeClient (the ForgeClient seam).
//
// The full app chrome (sidebar nav + topbar + sections) lives in ForgeApp,
// styled with the desktop design system (app/forge.css ported from the
// desktop's src/styles.css).
import { getCurrentUser, requireUser } from "@/lib/auth";
import { getAuthProvider } from "@/lib/auth-provider";
import { getPublicConfig } from "@/lib/self-host";
import { redirect } from "next/navigation";
import ForgeApp from "./ForgeApp";

export const dynamic = "force-dynamic";

// Web Forge (and the Auto section it hosts) is logged-in by design. This page
// is the only route that mounts ForgeApp/AutoSection, so gating it here gates
// the entire UI. Use the canonical `requireUser()` so unauthenticated users are
// sent to the active provider's sign-in flow; fall back to a manual redirect if
// enforcement is unavailable (e.g. auth env not configured).
export default async function ForgePage() {
  let user;
  try {
    user = await requireUser();
  } catch {
    user = await getCurrentUser();
    if (!user) {
      const url = await getAuthProvider()
        .getSignInUrl()
        .catch(() => "/auth/sign-in");
      redirect(url);
    }
  }
  // Resolve self-host / Market / credits / ecosystem-link config on the SERVER
  // (honors runtime env, not build-time NEXT_PUBLIC_* baking) and hand the
  // serializable snapshot to the client app.
  return <ForgeApp user={{ id: user.id, email: user.email }} config={getPublicConfig()} />;
}
