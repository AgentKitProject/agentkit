import Link from "next/link";
import { AdminSubmissionsList } from "@/components/AdminSubmissionsClient";
import { PageShell } from "@/components/PageShell";
import { getAdminConfigStatus } from "@/lib/admin-api";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminSubmissionsPage() {
  await requireAdmin();

  const config = getAdminConfigStatus();

  return (
    <PageShell
      eyebrow="Admin submissions"
      title="Submission queue"
      actions={<Link className="primary-button" href="/admin/upload">Upload kit</Link>}
    >
      {!config.isConfigured ? <MissingAdminConfig /> : <AdminSubmissionsList />}
    </PageShell>
  );
}

function MissingAdminConfig() {
  return (
    <div className="empty-state">
      <strong>Missing admin config</strong>
      <p>Server admin API configuration is incomplete. Check the deployment environment variables to load submissions.</p>
    </div>
  );
}
