import type { Metadata } from "next";
import { PageShell } from "@/components/PageShell";

export const metadata: Metadata = {
  title: "Security — AgentKitMarket",
  description: "AgentKitMarket security policy and responsible disclosure.",
};

export default function SecurityPage() {
  return (
    <PageShell eyebrow="Security" title="Security Policy">
      <div className="doc-panel">
        <h2>Reporting a Vulnerability</h2>
        <p>
          If you discover a security vulnerability in AgentKitMarket or any AgentKitProject service, please report it
          responsibly by emailing{" "}
          <a href="mailto:hello@agentkit-project.com?subject=Security%20Vulnerability%20Report">
            hello@agentkit-project.com
          </a>{" "}
          with the subject &quot;Security Vulnerability Report&quot;. Please do not publicly disclose vulnerabilities before we
          have had a chance to investigate and address them.
        </p>
        <h2>Responsible Disclosure Policy</h2>
        <p>We ask that security researchers:</p>
        <ul>
          <li>Report vulnerabilities privately before public disclosure.</li>
          <li>Allow reasonable time to investigate and remediate (typically 90 days).</li>
          <li>Do not access, modify, or delete user data beyond what is necessary to demonstrate the vulnerability.</li>
          <li>Do not perform denial-of-service attacks or social engineering against our team or users.</li>
        </ul>
        <p>
          We will acknowledge receipt of your report within 3 business days and keep you informed of our progress. We
          will not take legal action against researchers who follow this policy in good faith.
        </p>
        <h2>Scope</h2>
        <p>In scope: market.agentkitproject.com, forge.agentkitproject.com, profile.agentkitproject.com, webapp.forge.agentkitproject.com, and associated APIs.</p>
        <p>Out of scope: third-party services (WorkOS, Stripe, AWS), social engineering, physical attacks.</p>
        <h2>security.txt</h2>
        <p>
          Our security contact information is available at{" "}
          <a href="/.well-known/security.txt">/.well-known/security.txt</a>.
        </p>
        <p style={{ fontSize: "0.82rem", color: "var(--market-muted)", marginTop: 24 }}>Last updated: June 2026.</p>
      </div>
    </PageShell>
  );
}
