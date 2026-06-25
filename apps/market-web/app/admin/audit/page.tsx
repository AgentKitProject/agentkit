import { AuditLogsClient } from "@/components/AuditLogsClient";
import { PageShell } from "@/components/PageShell";
import { getAdminConfigStatus } from "@/lib/admin-api";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  await requireAdmin();

  const config = getAdminConfigStatus();

  return (
    <PageShell eyebrow="Admin audit" title="Audit log">
      {!config.isConfigured ? <MissingAdminConfig /> : <AuditLogsClient />}
    </PageShell>
  );
}

function MissingAdminConfig() {
  return (
    <div className="empty-state">
      <strong>Missing admin config</strong>
      <p>Server admin API configuration is incomplete. Check the deployment environment variables to load audit logs.</p>
    </div>
  );
}
