/**
 * Per-page heading wrapper for account-hub pages. The section navigation now
 * lives in the shared AppShell sidebar (SiteChrome), so this no longer renders
 * its own left rail — it just provides the eyebrow + title + a constrained
 * content column inside the AppShell content area.
 */
export function AccountShell({
  title,
  eyebrow = "AgentKitProject account",
  children,
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">{eyebrow}</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-[var(--ak-text)]">{title}</h1>
      <div className="mt-6">{children}</div>
    </div>
  );
}
