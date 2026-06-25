import { notFound } from "next/navigation";
import { Badge } from "@/components/Badge";
import { PageShell } from "@/components/PageShell";
import { getAuthRuntimeDiagnostics } from "@/lib/auth-debug";
import { getCurrentUser, isAdminEmail, isAdminRole } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DebugSessionPage() {
  const user = await getCurrentUser();
  const isDevelopment = process.env.NODE_ENV !== "production";
  const isAdmin = isAdminRole(user?.role);

  if (!isDevelopment && !isAdmin) {
    notFound();
  }

  const diagnostics = getAuthRuntimeDiagnostics();
  const adminAllowlistResult = user?.email ? isAdminEmail(user.email) : false;

  return (
    <PageShell
      eyebrow="Debug"
      title="Session"
    >
      <section className="detail-section">
        <p className="section-kicker">
          Safe AuthKit session diagnostics. Tokens, cookies, API keys, and authorization headers are intentionally not
          shown.
        </p>
        <div className="badge-row">
          <Badge tone={user ? "teal" : "muted"}>{user ? "Authenticated" : "Anonymous"}</Badge>
          <Badge tone={isAdmin ? "teal" : "muted"}>{user?.role ?? "anonymous"}</Badge>
        </div>
        <dl className="metadata-list">
          <div>
            <dt>Authenticated</dt>
            <dd>{String(Boolean(user))}</dd>
          </div>
          <div>
            <dt>User email</dt>
            <dd>{user?.email ?? "Not signed in"}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{user?.role ?? "anonymous"}</dd>
          </div>
          <div>
            <dt>Admin allowlist</dt>
            <dd>{String(adminAllowlistResult)}</dd>
          </div>
          <div>
            <dt>App URL</dt>
            <dd>{diagnostics.appUrl}</dd>
          </div>
          <div>
            <dt>WorkOS callback</dt>
            <dd>{diagnostics.workosRedirectUri}</dd>
          </div>
          <div>
            <dt>Cookie password configured</dt>
            <dd>{String(diagnostics.hasCookiePassword)}</dd>
          </div>
          <div>
            <dt>Cookie password length valid</dt>
            <dd>{String(diagnostics.cookiePasswordValidLength)}</dd>
          </div>
          <div>
            <dt>Cookie domain</dt>
            <dd>{diagnostics.cookieDomain ?? "Host-only"}</dd>
          </div>
          <div>
            <dt>Cookie SameSite</dt>
            <dd>{diagnostics.cookieSameSite}</dd>
          </div>
          <div>
            <dt>Cookie name</dt>
            <dd>{diagnostics.cookieName}</dd>
          </div>
        </dl>
      </section>
    </PageShell>
  );
}
