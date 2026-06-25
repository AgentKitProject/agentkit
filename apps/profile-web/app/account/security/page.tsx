import { AccountShell } from "@/components/AccountShell";
import { InfoPanel } from "@/components/InfoPanel";
import { requireUser } from "@/lib/auth/session";

export default async function SecurityPage() {
  await requireUser("/account/security");

  return (
    <AccountShell title="Security">
      <InfoPanel>
        <h2 className="text-lg font-semibold text-slate-950">Password and session settings</h2>
        <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
          AgentKitProject uses WorkOS AuthKit for hosted authentication. Managed password, passkey, and session controls should be connected here when the configured WorkOS account-security flow is available.
        </p>
        <div className="mt-6 rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-700">
          WorkOS-managed security settings placeholder
        </div>
      </InfoPanel>
    </AccountShell>
  );
}
