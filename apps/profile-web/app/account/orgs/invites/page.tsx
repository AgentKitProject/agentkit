import Link from "next/link";
import { AccountShell } from "@/components/AccountShell";
import { MyOrgInvitesList } from "@/components/orgs/OrgsClient";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function OrgInvitesPage() {
  await requireUser("/account/orgs/invites");

  return (
    <AccountShell title="Pending invites" eyebrow="AgentKitProject account">
      <div className="grid gap-6">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-[var(--muted)]">Accept an invite to join an organization and access its private kits.</p>
          <Link className="text-sm font-semibold text-[var(--brand)] hover:text-[var(--brand-strong)]" href="/account/orgs">
            My organizations
          </Link>
        </div>
        <MyOrgInvitesList />
      </div>
    </AccountShell>
  );
}
