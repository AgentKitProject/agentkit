import Link from "next/link";
import { PageShell } from "@/components/PageShell";

export default function MarketDocsPage() {
  return (
    <PageShell eyebrow="Documentation" title="AgentKitMarket model">
      <div className="doc-panel">
        <h2>Trust and visibility</h2>
        <p>
          Public catalog listings require both validation and review. Private and self-hosted catalogs may later allow
          validated-only listings depending on company policy.
        </p>
        <h2>AgentKitProject account</h2>
        <p>
          AgentKitProfile owns shared account and profile UX. AgentKitMarket links account actions there while keeping
          marketplace permissions for browsing, submitting, downloading, review, and publishing local.
        </p>
        <h2>Relationship to Forge and Auto</h2>
        <p>
          AgentKitForge remains the kit creation and import destination. AgentKitAuto is not implemented here, and its
          green identity is not the primary Market color system.
        </p>
        <Link className="secondary-link" href="/kits">
          Browse public catalog
        </Link>
      </div>
    </PageShell>
  );
}
