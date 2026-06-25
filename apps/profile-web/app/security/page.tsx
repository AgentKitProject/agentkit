import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Security — AgentKitProject",
  description: "AgentKitProject security policy and vulnerability reporting.",
};

export default function SecurityPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <p className="text-sm font-semibold uppercase tracking-wide text-[var(--brand)]">Security</p>
      <h1 className="mt-4 text-3xl font-semibold tracking-normal text-slate-950">Security Policy</h1>
      <div className="mt-8 space-y-6 text-[var(--foreground)]">
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Reporting a Vulnerability</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">
            If you discover a security vulnerability in any AgentKitProject service, please report it responsibly by emailing{" "}
            <a href="mailto:hello@agentkit-project.com" className="font-semibold text-[var(--brand)] hover:text-[var(--brand-strong)]">
              hello@agentkit-project.com
            </a>
            . Please do not disclose vulnerabilities publicly before we have had a chance to address them.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Responsible Disclosure</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">We ask that you give us reasonable time to investigate and remediate reported issues before any public disclosure. We will acknowledge your report promptly and keep you informed of our progress.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Scope</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">This policy covers all AgentKitProject services including AgentKitMarket, AgentKitForge, AgentKitProfile, and the AgentKitProject website. Third-party services integrated into our platform (such as WorkOS) have their own security policies.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-slate-950">security.txt</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">
            Our security contact information is also available in machine-readable form at{" "}
            <a href="/.well-known/security.txt" className="font-semibold text-[var(--brand)] hover:text-[var(--brand-strong)]">
              /.well-known/security.txt
            </a>
            .
          </p>
        </section>
        <p className="text-sm text-[var(--muted)]">Last updated: June 2026.</p>
      </div>
    </main>
  );
}
