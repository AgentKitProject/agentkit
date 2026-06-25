"use client";

import Link from "next/link";
import { SiteShell, DEFAULT_FOOTER_LINKS, navWithActive, type FooterLinks } from "@agentkitforge/ui";
import { HeaderAuthNav } from "@/components/HeaderAuthNav";

/** Profile brand teal — also wired into the root tokens (globals.css). */
const PROFILE_TEAL = "#2f8f89";

/** Profile logo: the teal-tile mark + "AgentKitProject account" wordmark. */
function ProfileLogo() {
  return (
    <Link
      href="/"
      className="flex items-center gap-2 font-semibold tracking-normal text-[var(--brand-strong)]"
      aria-label="AgentKitProject account home"
    >
      <svg
        width="26"
        height="26"
        viewBox="0 0 28 28"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <rect width="28" height="28" rx="6" fill="var(--brand)" />
        <path d="M7 20L14 8L21 20H7Z" fill="white" fillOpacity="0.95" />
      </svg>
      <span className="text-sm">
        <span className="font-bold text-slate-900">AgentKit</span>
        <span className="font-semibold text-[var(--brand)]">Project</span>
        <span className="ml-1 text-xs font-medium text-[var(--muted)]">account</span>
      </span>
    </Link>
  );
}

/** Profile-specific footer link set (keeps the local account/legal routes). */
const PROFILE_FOOTER_LINKS: Partial<FooterLinks> = {
  ecosystem: [
    ...DEFAULT_FOOTER_LINKS.ecosystem.filter((l) => l.label !== "Account"),
    { label: "Account", href: "/" },
  ],
  legal: [
    { label: "Privacy", href: "/privacy" },
    { label: "Terms", href: "/terms" },
    { label: "Kit License", href: "/legal/kit-license" },
    { label: "Security", href: "/security" },
  ],
};

export function SiteChrome({ children }: { children: React.ReactNode }) {
  return (
    <SiteShell
      brandAccent={PROFILE_TEAL}
      logo={<ProfileLogo />}
      nav={navWithActive("Account")}
      account={<HeaderAuthNav />}
      footer={{
        brandTitle: "AgentKitProject account",
        brandSubtitle: "Shared identity for the AgentKitProject ecosystem.",
        links: PROFILE_FOOTER_LINKS,
      }}
    >
      {children}
    </SiteShell>
  );
}
