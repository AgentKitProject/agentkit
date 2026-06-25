import { redirect } from "next/navigation";
import Link from "next/link";
import { PageShell } from "@/components/PageShell";
import { OrgMembersPanel } from "@/components/OrgsClient";
import { CommercialPayouts } from "@/components/CommercialPayouts";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ orgId: string }>;
};

export default async function OrgDetailPage({ params }: PageProps) {
  const user = await getCurrentUser();

  if (!user) {
    const { orgId } = await params;
    redirect(`/auth/sign-in?returnTo=${encodeURIComponent(`/orgs/${orgId}`)}`);
  }

  const { orgId } = await params;

  return (
    <PageShell
      eyebrow="Organizations"
      title="Organization details"
      actions={
        <Link className="secondary-link" href="/orgs">
          ← All organizations
        </Link>
      }
    >
      <OrgMembersPanel orgId={orgId} />
      <CommercialPayouts orgId={orgId} />
    </PageShell>
  );
}
