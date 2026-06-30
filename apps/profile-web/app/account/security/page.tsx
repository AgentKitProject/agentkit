import { AccountShell } from "@/components/AccountShell";
import { InfoPanel } from "@/components/InfoPanel";
import { requireUser } from "@/lib/auth/session";
import { getUserRole } from "@/lib/auth/roles";
import { isOidcProvider } from "@/lib/auth-provider";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const user = await requireUser("/account/security");
  const role = getUserRole(user);
  const oidc = isOidcProvider();

  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();

  const providerTitle = oidc ? "Managed by your identity provider" : "Managed by WorkOS AuthKit";
  const providerCopy = oidc
    ? "Passwords, passkeys, and multi-factor authentication are managed by your identity provider (your OIDC provider / Dex). Update those credentials wherever your organization signs in."
    : "Passwords, passkeys, and multi-factor authentication are managed by WorkOS AuthKit. Update those credentials through the WorkOS-hosted sign-in experience.";

  return (
    <AccountShell title="Security">
      <div className="grid gap-6">
        <InfoPanel>
          <h2 className="text-lg font-semibold text-[var(--ak-text)]">Signed-in identity</h2>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <SecurityItem label="Email" value={user.email || "Not available"} />
            <SecurityItem label="Role" value={role} />
            {fullName ? <SecurityItem label="Name" value={fullName} /> : null}
          </dl>
        </InfoPanel>

        <InfoPanel>
          <h2 className="text-lg font-semibold text-[var(--ak-text)]">{providerTitle}</h2>
          <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{providerCopy}</p>
          <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
            AgentKitProject does not store your password. Credential and session management lives with the identity
            provider.
          </p>
        </InfoPanel>
      </div>
    </AccountShell>
  );
}

function SecurityItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{label}</dt>
      <dd className="mt-1 text-base font-medium text-[var(--ak-text)]">{value}</dd>
    </div>
  );
}
