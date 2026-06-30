import Link from "next/link";
import { AccountShell } from "@/components/AccountShell";
import { OrgMembersPanel, OrgApiKeyPanel, OrgRunBudgetPanel, OrgMonthlyLimitsPanel } from "@/components/orgs/OrgsClient";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ orgId: string }>;
};

export default async function OrgDetailPage({ params }: PageProps) {
  const { orgId } = await params;
  const user = await requireUser(`/account/orgs/${orgId}`);

  return (
    <AccountShell title="Organization details" eyebrow="AgentKitProject account">
      <div className="grid gap-8">
        <div>
          <Link className="text-sm font-semibold text-[var(--brand)] hover:text-[var(--brand-strong)]" href="/account/orgs">
            ← All organizations
          </Link>
        </div>
        <OrgMembersPanel orgId={orgId} />
        <OrgApiKeyPanel orgId={orgId} viewerUserId={user.id} />
        <OrgRunBudgetPanel orgId={orgId} viewerUserId={user.id} />
        <OrgMonthlyLimitsPanel orgId={orgId} viewerUserId={user.id} />
      </div>
    </AccountShell>
  );
}
