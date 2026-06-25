import Link from "next/link";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/PageShell";
import { UserSubmissionForm } from "@/components/UserSubmissionForm";
import { getAdminConfigStatus } from "@/lib/admin-api";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SubmitPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/auth/sign-in?returnTo=${encodeURIComponent("/submit")}`);
  }

  const config = getAdminConfigStatus();

  return (
    <PageShell
      eyebrow="Submit kit"
      title="Submit an Agent Kit"
      actions={<Link className="ghost-button" href="/submissions">My submissions</Link>}
    >
      <div className="rule-callout">
        <strong>Signed-in submission</strong>
        <span>Any AgentKitProject account can submit a kit. Your account is attached automatically.</span>
      </div>
      <div className="info-grid">
        <div className="flow-card">
          <h3>1. Upload package</h3>
          <p>Submit a .agentkit.zip package with public-safe listing metadata.</p>
        </div>
        <div className="flow-card">
          <h3>2. Validation runs</h3>
          <p>Market checks the package before it can be reviewed for publication.</p>
        </div>
        <div className="flow-card">
          <h3>3. Admin review</h3>
          <p>Approved listings become public after validation and admin publishing.</p>
        </div>
      </div>
      <UserSubmissionForm isConfigured={config.isConfigured} />
    </PageShell>
  );
}
