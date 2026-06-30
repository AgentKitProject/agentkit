import Link from "next/link";
import { AccountShell } from "@/components/AccountShell";
import { OrgList } from "@/components/orgs/OrgsClient";
import { requireUser } from "@/lib/auth/session";
import { getUserRole } from "@/lib/auth/roles";
import { isSelfHost } from "@/lib/self-host";

export const dynamic = "force-dynamic";

export default async function OrgsPage() {
  const user = await requireUser("/account/orgs");

  // Self-host only: org creation is admin-only (mirrors the POST /api/orgs gate).
  // Hosted → anyone can create.
  const role = getUserRole(user);
  const canCreateOrg = !isSelfHost() || role === "owner" || role === "admin";

  return (
    <AccountShell title="Organizations" eyebrow="AgentKitProject account">
      <div className="grid gap-6">
        <div className="rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-700">
          <strong className="text-slate-950">Teams</strong>
          <p className="mt-1 text-[var(--muted)]">
            Organizations let you share kits with colleagues and control catalog visibility. Create a team org and invite
            members by email.
          </p>
          <div className="mt-3">
            <Link className="text-sm font-semibold text-[var(--brand)] hover:text-[var(--brand-strong)]" href="/account/orgs/invites">
              Pending invites
            </Link>
          </div>
        </div>
        <OrgList canCreateOrg={canCreateOrg} />
      </div>
    </AccountShell>
  );
}
