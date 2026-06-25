import type { Metadata } from "next";
import { PageShell } from "@/components/PageShell";

export const metadata: Metadata = {
  title: "Terms of Service — AgentKitMarket",
  description: "AgentKitMarket terms of service.",
};

export default function TermsPage() {
  return (
    <PageShell eyebrow="Legal" title="Terms of Service">
      <div className="doc-panel">
        <p style={{ padding: "10px 14px", background: "#fffbeb", border: "1px solid #f59e0b", borderRadius: 8, marginBottom: 18, fontSize: "0.88rem", fontWeight: 600 }}>
          Template — not legal advice; review with counsel before publishing.
        </p>
        <h2>Acceptance</h2>
        <p>By accessing or using AgentKitMarket, you agree to these Terms of Service. If you do not agree, do not use the service.</p>
        <h2>Use of Service</h2>
        <p>You may use AgentKitMarket to discover, submit, and download Agent Kits in accordance with these terms. You must not use the service for unlawful purposes or in ways that harm other users or the AgentKitProject ecosystem.</p>
        <h2>Content</h2>
        <p>Publishers are responsible for the content of Agent Kits they submit. AgentKitProject reserves the right to remove content that violates these terms or applicable law. All kits go through an admin review process before publication.</p>
        <h2>Accounts</h2>
        <p>You must create an account to submit or download Agent Kits. You are responsible for maintaining the security of your account credentials. Accounts are managed via the AgentKitProfile service.</p>
        <h2>Payments</h2>
        <p>Paid kit purchases are processed by Stripe. By purchasing a kit you agree to Stripe&apos;s terms of service. AgentKitProject does not store payment card details. All sales are final unless otherwise stated by the publisher.</p>
        <h2>Limitation of Liability</h2>
        <p>AgentKitMarket and AgentKitProject are provided &quot;as is&quot; without warranty of any kind. To the maximum extent permitted by law, AgentKitProject shall not be liable for any indirect, incidental, or consequential damages arising from use of the service.</p>
        <h2>Governing Law</h2>
        <p>These terms are governed by applicable law. Disputes shall be resolved in accordance with applicable jurisdiction.</p>
        <h2>Changes</h2>
        <p>We may update these terms from time to time. Continued use of the service after changes constitutes acceptance of the new terms.</p>
        <h2>Contact</h2>
        <p><a href="mailto:hello@agentkit-project.com">hello@agentkit-project.com</a></p>
        <p style={{ fontSize: "0.82rem", color: "var(--market-muted)", marginTop: 24 }}>Last updated: June 2026.</p>
      </div>
    </PageShell>
  );
}
