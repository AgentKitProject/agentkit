// Inert stub for "My Purchases". The real page (entitlement list + licensed
// downloads) lives in the optional @agentkit-commercial/market-web package and
// is only mounted when NEXT_PUBLIC_COMMERCE_ENABLED=1. On the public/free build
// it renders a clear "not available" notice; nothing resolves the commercial
// module at build time.
import type { ReactNode } from "react";
import { PageShell } from "@/components/PageShell";
import { isCommerceEnabled } from "@/lib/commercial";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function PurchasesPage() {
  if (isCommerceEnabled()) {
    // Commercial layer present: defer to its real implementation. The dynamic
    // specifier keeps the public build from hard-resolving the optional package.
    try {
      const mod = (await import(
        /* webpackIgnore: true */ "@agentkit-commercial/market-web"
      )) as { PurchasesPage?: () => unknown };
      if (typeof mod.PurchasesPage === "function") {
        return mod.PurchasesPage() as ReactNode;
      }
    } catch {
      // fall through to the inert notice
    }
  }

  return (
    <PageShell eyebrow="Your library" title="My Purchases">
      <div className="rule-callout">
        <strong>Purchases are not available on this instance</strong>
        <span>
          This AgentKitMarket instance runs the free path only. Paid kits and
          purchase history are part of the hosted commercial offering.
        </span>
      </div>
    </PageShell>
  );
}
