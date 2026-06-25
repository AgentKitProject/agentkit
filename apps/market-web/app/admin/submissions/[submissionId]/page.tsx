import Link from "next/link";
import { AdminSubmissionDetail } from "@/components/AdminSubmissionsClient";
import { PageShell } from "@/components/PageShell";
import { getAdminConfigStatus } from "@/lib/admin-api";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminSubmissionDetailPage({ params }: { params: Promise<{ submissionId: string }> }) {
  await requireAdmin();

  const { submissionId } = await params;
  const config = getAdminConfigStatus();

  return (
    <PageShell
      eyebrow="Submission detail"
      title="Submission"
      actions={<Link className="ghost-button" href="/admin/submissions">Back to queue</Link>}
    >
      {!config.isConfigured ? (
        <div className="empty-state">
          <strong>Admin config required</strong>
          <p>Server admin API configuration is incomplete. Check the deployment environment variables to view submission details.</p>
        </div>
      ) : (
        <AdminSubmissionDetail submissionId={submissionId} />
      )}
    </PageShell>
  );
}
