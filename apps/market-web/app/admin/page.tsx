import Link from "next/link";
import { PageShell } from "@/components/PageShell";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  await requireAdmin();

  return (
    <PageShell eyebrow="Admin console" title="Marketplace operations">
      <div className="two-column">
        <div className="flow-card action-card">
          <h2>Upload package</h2>
          <p>Upload a `.agentkit.zip` package, create a submission, and queue validation.</p>
          <Link className="primary-button" href="/admin/upload">
            Upload kit
          </Link>
        </div>
        <div className="flow-card">
          <h2>Submissions</h2>
          <p>Track validation status, review status, and extracted public-safe metadata.</p>
          <Link className="secondary-link" href="/admin/submissions">
            View submissions
          </Link>
        </div>
        <div className="flow-card">
          <h2>Review queue</h2>
          <p>Approve, reject, publish, or hide kits after validation produces public-safe metadata.</p>
          <Link className="secondary-link" href="/admin/review">
            Open queue
          </Link>
        </div>
        <div className="flow-card">
          <h2>Audit log</h2>
          <p>Append-only record of significant mutations: submissions, publishes, hides, org changes, and entitlements.</p>
          <Link className="secondary-link" href="/admin/audit">
            View audit log
          </Link>
        </div>
        <div className="flow-card">
          <h2>Trust policy</h2>
          <p>Public listings require status=published, validationStatus=passed, and reviewStatus=approved.</p>
        </div>
      </div>
      <div className="rule-callout">
        <strong>Admin access is restricted</strong>
        <span>AgentKitProject account sign-in and the admin email allowlist are required.</span>
      </div>
    </PageShell>
  );
}
