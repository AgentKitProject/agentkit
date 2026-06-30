// AgentKitAuto — the single application surface.
//
// Auth-gated: an authenticated cookie session is required before the Auto
// dashboard renders. Same gate Web Forge uses. The active provider (WorkOS
// AuthKit hosted, or generic OIDC self-hosted) is selected by AUTH_PROVIDER; this
// page consumes only the abstract user. The browser UI talks to the cookie-auth
// /api/auto/* routes; the bearer /api/forge/auto/* routes are for desktop/CLI.
//
// Session refresh + cookie writes happen in middleware.ts, NOT during this render
// — calling `requireUser()` raw can make the provider try to write the refreshed
// session cookie during the Server Component render, which Next.js forbids
// ("Cookies can only be modified in a Server Action or Route Handler") and
// surfaces as a 500. So we mirror Web Forge: attempt `requireUser()`, and on
// failure fall back to a non-writing `getCurrentUser()` plus a manual
// `redirect()` to the active provider's sign-in flow.
import { getCurrentUser, requireUser } from "@/lib/auth";
import { getAuthProvider } from "@/lib/auth-provider";
import { getPublicConfig } from "@/lib/self-host";
import { redirect } from "next/navigation";
import { AutoApp } from "./AutoApp";

export const dynamic = "force-dynamic";

export default async function Page() {
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
  const { links, marketEnabled, allowedProviders } = getPublicConfig();
  return (
    <AutoApp
      user={{ id: user.id, email: user.email }}
      marketUrl={links.marketUrl}
      profileUrl={links.profileUrl}
      marketEnabled={marketEnabled}
      allowedProviders={allowedProviders}
    />
  );
}
