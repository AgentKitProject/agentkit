import Link from "next/link";
import { PageShell } from "@/components/PageShell";
import { requireUser } from "@/lib/auth";

export default async function AdminUnauthorizedPage() {
  const user = await requireUser();

  return (
    <PageShell eyebrow="Admin access" title="Unauthorized">
      <div className="empty-state danger-state">
        <strong>Admin role required</strong>
        <p>{user.email} is signed in with an AgentKitProject account, but is not on the Market admin allowlist.</p>
        <Link className="primary-button" href="/">
          Back to public catalog
        </Link>
      </div>
    </PageShell>
  );
}
