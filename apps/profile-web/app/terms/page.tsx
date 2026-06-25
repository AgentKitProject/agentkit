import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — AgentKitProject",
  description: "AgentKitProject account terms of service.",
};

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <p className="text-sm font-semibold uppercase tracking-wide text-[var(--brand)]">Legal</p>
      <h1 className="mt-4 text-3xl font-semibold tracking-normal text-slate-950">Terms of Service</h1>
      <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
        Template — not legal advice; review with counsel before publishing.
      </div>
      <div className="mt-8 space-y-6 text-[var(--foreground)]">
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Acceptance</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">By using AgentKitProject services, you agree to these Terms of Service. If you do not agree, do not use the services.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Use of Service</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">You may use AgentKitProject services for lawful purposes only. You must not misuse the services, attempt to gain unauthorized access, or violate any applicable laws or regulations.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Accounts</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">You are responsible for maintaining the security of your account and for all activity that occurs under it. Notify us immediately of any unauthorized access.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Limitation of Liability</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">To the fullest extent permitted by law, AgentKitProject and its affiliates shall not be liable for indirect, incidental, special, or consequential damages arising from your use of the services.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Governing Law</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">These terms are governed by applicable law. Disputes will be resolved in the applicable jurisdiction.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Changes</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">We may update these terms from time to time. Continued use of the services after changes constitutes acceptance of the revised terms.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Contact</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]"><a href="mailto:hello@agentkit-project.com" className="font-semibold text-[var(--brand)] hover:text-[var(--brand-strong)]">hello@agentkit-project.com</a></p>
        </section>
        <p className="text-sm text-[var(--muted)]">Last updated: June 2026.</p>
      </div>
    </main>
  );
}
