import Link from "next/link";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/PageShell";
import { UserSubmissionDetail } from "@/components/UserSubmissionsClient";
import { getAdminConfigStatus } from "@/lib/admin-api";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ submissionId: string }>;
};

export default async function SubmissionDetailPage({ params }: PageProps) {
  const user = await getCurrentUser();
  const { submissionId } = await params;

  if (!user) {
    redirect(`/auth/sign-in?returnTo=${encodeURIComponent(`/submissions/${submissionId}`)}`);
  }

  const config = getAdminConfigStatus();

  return (
    <PageShell
      eyebrow="Submission status"
      title="Submission detail"
      actions={<Link className="ghost-button" href="/submissions">Back to my submissions</Link>}
    >
      {!config.isConfigured ? <MissingSubmissionConfig /> : <UserSubmissionDetail submissionId={submissionId} />}
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
