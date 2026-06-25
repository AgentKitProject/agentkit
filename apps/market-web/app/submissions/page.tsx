import Link from "next/link";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/PageShell";
import { UserSubmissionsList } from "@/components/UserSubmissionsClient";
import { getAdminConfigStatus } from "@/lib/admin-api";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SubmissionsPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/auth/sign-in?returnTo=${encodeURIComponent("/submissions")}`);
  }

  const config = getAdminConfigStatus();

  return (
    <PageShell
      eyebrow="My submissions"
      title="Submitted Agent Kits"
      actions={<Link className="primary-button" href="/submit">Submit kit</Link>}
    >
      <div className="rule-callout">
        <strong>Review required</strong>
        <span>Your submissions stay private until validation passes and an admin approves and publishes the listing.</span>
      </div>
      {!config.isConfigured ? <MissingSubmissionConfig /> : <UserSubmissionsList />}
    </PageShell>
  );
}

function MissingSubmissionConfig() {
  return (
    <div className="empty-state">
      <strong>Submission system unavailable</strong>
      <p>Server submission configuration is incomplete. Please try again after Market support updates the deployment.</p>
    </div>
  );
}
