import Link from "next/link";
import { AdminSubmissionsList } from "@/components/AdminSubmissionsClient";
import { PageShell } from "@/components/PageShell";
import { getAdminConfigStatus } from "@/lib/admin-api";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminReviewPage() {
  await requireAdmin();

  const config = getAdminConfigStatus();

  return (
    <PageShell
      eyebrow="Admin review"
      title="Review and publish queue"
      actions={<Link className="ghost-button" href="/admin/submissions">All submissions</Link>}
    >
      <div className="rule-callout">
        <strong>Public listing gate</strong>
        <span>Public catalog visibility requires status=published, validationStatus=passed, and reviewStatus=approved.</span>
      </div>
      {!config.isConfigured ? <MissingAdminConfig /> : <AdminSubmissionsList reviewMode />}
    </PageShell>
  );
}

function MissingAdminConfig() {
  return (
    <div className="empty-state">
      <strong>Missing admin config</strong>
      <p>Server admin API configuration is incomplete. Check the deployment environment variables to load the review queue.</p>
    </div>
  );
}
