import { redirect } from "next/navigation";
import Link from "next/link";
import { PageShell } from "@/components/PageShell";
import { MyOrgInvitesList } from "@/components/OrgsClient";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function OrgInvitesPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/auth/sign-in?returnTo=${encodeURIComponent("/orgs/invites")}`);
  }

  return (
    <PageShell
      eyebrow="Organizations"
      title="Pending invites"
      actions={
        <Link className="secondary-link" href="/orgs">
          My organizations
        </Link>
      }
    >
      <p>Accept an invite to join an organization and access its private kits.</p>
      <MyOrgInvitesList />
    </PageShell>
  );
}
