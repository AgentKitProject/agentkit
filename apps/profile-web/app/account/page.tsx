import Link from "next/link";
import { AccountShell } from "@/components/AccountShell";
import { AccountProfileSummary } from "@/components/AccountProfileSummary";
import { ConnectedApps } from "@/components/ConnectedApps";
import { InfoPanel } from "@/components/InfoPanel";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  await requireUser("/account");

  return (
    <AccountShell title="Account overview">
      <div className="grid gap-6">
        <InfoPanel>
          <AccountProfileSummary />
        </InfoPanel>

        <div>
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-xl font-semibold text-[var(--ak-text)]">Connected apps</h2>
            <Link className="text-sm font-semibold text-[var(--brand)] hover:text-[var(--brand-strong)]" href="/account/products">
              View all
            </Link>
          </div>
          <ConnectedApps />
        </div>
      </div>
    </AccountShell>
  );
}
