import { AccountShell } from "@/components/AccountShell";
import { ConnectedApps } from "@/components/ConnectedApps";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  await requireUser("/account/products");

  return (
    <AccountShell title="Connected apps">
      <ConnectedApps />
    </AccountShell>
  );
}
