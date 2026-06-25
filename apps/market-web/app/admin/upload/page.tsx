import { AdminUploadForm } from "@/components/AdminUploadForm";
import { PageShell } from "@/components/PageShell";
import { getAdminConfigStatus } from "@/lib/admin-api";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminUploadPage() {
  await requireAdmin();

  const config = getAdminConfigStatus();

  return (
    <PageShell eyebrow="Admin upload" title="Upload Agent Kit package">
      <div className="rule-callout">
        <strong>Admin upload flow</strong>
        <span>Use `.agentkit.zip` packages only. AgentKitProject account admin access is required.</span>
      </div>
      <AdminUploadForm isConfigured={config.isConfigured} />
    </PageShell>
  );
}
