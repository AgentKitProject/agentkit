import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Kit License — AgentKitProject",
  description: "AgentKitProject Standard Kit License (default-v1) — the default EULA applied to Agent Kits distributed via AgentKitMarket.",
};

/**
 * AgentKitProject Standard Kit License (default-v1)
 *
 * Mirrors the default-v1 text from @agentkitforge/core and agentkitmarket-app/lib/kit-license.ts.
 * Keep in sync when the default license text changes.
 *
 * Template — not legal advice; review with counsel before publishing.
 */
const KIT_LICENSE_TEXT = `AgentKitProject Standard Kit License (default-v1)

1. Grant. Subject to your acceptance of these terms and, for paid kits, your
   completed acquisition, the publisher grants you a non-exclusive,
   non-transferable license to use this Agent Kit and its contents (the
   "Kit") for your own and your organization's internal purposes.

2. Restrictions. You may not resell, sublicense, publicly redistribute, or
   republish the Kit or its contents as a standalone product. You may not
   remove or alter any provenance, attribution, or watermark embedded in the
   Kit package.

3. Online-only kits. Some paid kits are made available for in-product
   (AgentKitForge) use only and are not provided as a downloadable package.
   Your license does not entitle you to a downloadable copy of such kits.

4. Ownership. The publisher (or its licensors) retains all right, title, and
   interest in and to the Kit. No rights are granted except as expressly set
   out here.

5. No warranty. The Kit is provided "as is" without warranty of any kind.
   AgentKitProject and the publisher are not liable for any damages arising
   from your use of the Kit, to the maximum extent permitted by law.

6. Termination. This license terminates automatically if you breach these
   terms. Upon termination you must stop using and delete any local copies of
   the Kit.

By accepting, you confirm that you have read and agree to this license.`;

export default function KitLicensePage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <p className="text-sm font-semibold uppercase tracking-wide text-[var(--brand)]">Legal</p>
      <h1 className="mt-4 text-3xl font-semibold tracking-normal text-slate-950">
        AgentKitProject Standard Kit License
      </h1>
      <p className="mt-2 text-sm text-[var(--muted)]">Version: default-v1</p>
      <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
        Template — not legal advice; review with counsel before publishing.
      </div>
      <div className="mt-8 space-y-4 text-[var(--foreground)]">
        <p className="text-sm leading-6 text-[var(--muted)]">
          This is the default End User License Agreement (EULA) applied to Agent Kits distributed via{" "}
          <a href="https://market.agentkitproject.com" className="font-semibold text-[var(--brand)] hover:text-[var(--brand-strong)]">
            AgentKitMarket
          </a>{" "}
          when a publisher has not specified a custom license. Publishers may provide their own license
          text at submission time, which will be shown to users before download.
        </p>
        <pre className="mt-6 overflow-x-auto rounded-lg border border-[var(--line)] bg-slate-50 p-5 text-xs leading-6 text-slate-700 whitespace-pre-wrap">
          {KIT_LICENSE_TEXT}
        </pre>
        <section className="mt-6">
          <h2 className="text-xl font-semibold text-slate-950">Questions</h2>
          <p className="mt-3 leading-7 text-[var(--muted)]">
            For questions about licensing or to report misuse, contact us at{" "}
            <a href="mailto:hello@agentkit-project.com" className="font-semibold text-[var(--brand)] hover:text-[var(--brand-strong)]">
              hello@agentkit-project.com
            </a>
            .
          </p>
        </section>
        <p className="text-sm text-[var(--muted)]">Last updated: June 2026.</p>
      </div>
    </main>
  );
}
