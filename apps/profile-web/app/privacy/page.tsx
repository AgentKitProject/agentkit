import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — AgentKitProject",
  description: "AgentKitProject account privacy policy.",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <p className="text-sm font-semibold uppercase tracking-wide text-[var(--brand)]">Legal</p>
      <h1 className="mt-4 text-3xl font-semibold tracking-normal text-slate-950">Privacy Policy</h1>
      <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
        Template — not legal advice; review with counsel before publishing.
      </div>
      <div className="mt-8 space-y-6 text-[var(--foreground)]">
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Data We Collect</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">We collect your email address, display name, and handle when you create an account. We also collect usage data to operate the service.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-slate-950">How We Use Data</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">We use your data to provide, improve, and secure AgentKitProject services including AgentKitMarket, AgentKitForge, and AgentKitAuto.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Cookies</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">We use cookies for authentication sessions managed by WorkOS.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Third Parties</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">We use WorkOS for authentication and identity management.</p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-slate-950">Your Rights</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">You may request access to, correction of, or deletion of your personal data by contacting us.</p>
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
