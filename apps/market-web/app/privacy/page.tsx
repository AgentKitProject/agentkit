import type { Metadata } from "next";
import { PageShell } from "@/components/PageShell";

export const metadata: Metadata = {
  title: "Privacy Policy — AgentKitMarket",
  description: "AgentKitMarket privacy policy.",
};

export default function PrivacyPage() {
  return (
    <PageShell eyebrow="Legal" title="Privacy Policy">
      <div className="doc-panel">
        <p style={{ padding: "10px 14px", background: "#fffbeb", border: "1px solid #f59e0b", borderRadius: 8, marginBottom: 18, fontSize: "0.88rem", fontWeight: 600 }}>
          Template — not legal advice; review with counsel before publishing.
        </p>
        <h2>Data We Collect</h2>
        <p>We collect information you provide when creating an account (email address) and usage data to operate the service.</p>
        <h2>How We Use Data</h2>
        <p>We use your data to provide, improve, and secure AgentKitMarket and the AgentKitProject ecosystem.</p>
        <h2>Cookies</h2>
        <p>We use cookies for authentication sessions managed by WorkOS.</p>
        <h2>Third Parties</h2>
        <p>We use WorkOS for authentication and identity management, and Stripe for payment processing.</p>
        <h2>Your Rights</h2>
        <p>You may request access to, correction of, or deletion of your personal data by contacting us.</p>
        <h2>Contact</h2>
        <p><a href="mailto:hello@agentkit-project.com">hello@agentkit-project.com</a></p>
        <p style={{ fontSize: "0.82rem", color: "var(--market-muted)", marginTop: 24 }}>Last updated: June 2026.</p>
      </div>
    </PageShell>
  );
}
