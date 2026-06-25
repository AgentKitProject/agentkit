import { redirect } from "next/navigation";
import Link from "next/link";
import { PageShell } from "@/components/PageShell";
import { OrgList } from "@/components/OrgsClient";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function OrgsPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/auth/sign-in?returnTo=${encodeURIComponent("/orgs")}`);
  }

  return (
    <PageShell
      eyebrow="Account"
      title="My organizations"
      actions={
        <Link className="secondary-link" href="/orgs/invites">
          Pending invites
        </Link>
      }
    >
      <div className="rule-callout">
        <strong>Teams</strong>
        <span>
          Organizations let you share kits with colleagues and control catalog visibility. Create a team org and invite
          members by user ID.
        </span>
      </div>
      <OrgList />
    </PageShell>
  );
}
