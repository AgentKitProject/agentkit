import type { Metadata } from "next";
import { PageShell } from "@/components/PageShell";
import { DEFAULT_KIT_LICENSE_TEXT } from "@/lib/kit-license";

export const metadata: Metadata = {
  title: "Standard Kit License — AgentKitMarket",
  description: "The default AgentKitProject Standard Kit License applied to Agent Kits on the market.",
};

export default function KitLicensePage() {
  return (
    <PageShell eyebrow="Legal" title="Standard Kit License">
      <div className="doc-panel">
        <p>This is the default license applied to Agent Kits published on AgentKitMarket unless the publisher provides a custom license.</p>
        <pre className="license-text">{DEFAULT_KIT_LICENSE_TEXT}</pre>
      </div>
    </PageShell>
  );
}
