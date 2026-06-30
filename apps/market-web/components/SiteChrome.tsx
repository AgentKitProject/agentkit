"use client";

import { type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AppShell,
  SidebarAccountFooter,
  BRAND_ACCENTS,
  buildAppSwitcher,
  type SidebarNavItem,
} from "@agentkitforge/ui";
import type { EcosystemLinks } from "@/lib/self-host";

export type SiteChromeProps = {
  /** Whether a user is signed in (resolved server-side). */
  signedIn: boolean;
  /** Signed-in user's email (resolved server-side) for the account tile. */
  userEmail?: string;
  /** Whether the signed-in user has an admin role. */
  showAdmin: boolean;
  /**
   * True when this is a self-hosted instance. Resolved server-side. The sidebar
   * never surfaces cross-ecosystem app links (Forge / Auto) in any mode — only
   * this Market's local routes plus a single external Docs link.
   */
  selfHost?: boolean;
  /**
   * Cross-ecosystem link bases (resolved server-side). On hosted these are the
   * public *.agentkitproject.com URLs; on self-host only operator-configured ones
   * are present (plus Docs, which always defaults).
   */
  ecosystemLinks?: EcosystemLinks;
  children: ReactNode;
};

// Minimal 18px stroke icons for the sidebar nav (no icon dependency), mirroring
// the style used by apps/auto-web/app/AutoApp.tsx SECTION_ICONS.
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const ICONS = {
  // Catalog — grid of kit cards.
  catalog: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
    </svg>
  ),
  // Submit — upload arrow.
  submit: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
      <path d="M12 16V5m0 0l-4 4m4-4l4 4" />
      <path d="M5 19h14" />
    </svg>
  ),
  // My submissions — document list.
  submissions: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
      <path d="M6 3.5h8l4 4V20a1 1 0 01-1 1H6a1 1 0 01-1-1V4.5a1 1 0 011-1z" />
      <path d="M13.5 3.5V8h4.5M8.5 12.5h7M8.5 16h7" />
    </svg>
  ),
  // Purchases — receipt / tag.
  purchases: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
      <path d="M4 7l1.2-2.5h13.6L20 7M4 7v12a1 1 0 001 1h14a1 1 0 001-1V7M4 7h16" />
      <path d="M9 11a3 3 0 006 0" />
    </svg>
  ),
  // Organizations — building / people.
  orgs: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
      <path d="M4 20V6a1 1 0 011-1h6a1 1 0 011 1v14" />
      <path d="M12 20v-8a1 1 0 011-1h6a1 1 0 011 1v8" />
      <path d="M7 8h2M7 11h2M7 14h2M15 14h2M15 17h2M3 20h18" />
    </svg>
  ),
  // Admin — shield with check.
  admin: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  // Docs — book.
  docs: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
      <path d="M5 4.5h9a2 2 0 012 2V20a1.5 1.5 0 00-1.5-1.5H5z" />
      <path d="M5 4.5A1.5 1.5 0 003.5 6v13A1.5 1.5 0 015 17.5" />
    </svg>
  ),
  // Sign out — door / arrow.
  signOut: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
      <path d="M15 12H6m0 0l3-3m-3 3l3 3" />
      <path d="M11 4.5h6a1 1 0 011 1v13a1 1 0 01-1 1h-6" />
    </svg>
  ),
} as const;

/** Local app routes and the topbar title they map to. */
const ROUTE_TITLES: { prefix: string; title: string; label: string; icon: ReactNode }[] = [
  { prefix: "/kits", title: "Catalog", label: "Catalog", icon: ICONS.catalog },
  { prefix: "/submit", title: "Submit", label: "Submit", icon: ICONS.submit },
  { prefix: "/submissions", title: "My submissions", label: "My Submissions", icon: ICONS.submissions },
  { prefix: "/purchases", title: "Purchases", label: "Purchases", icon: ICONS.purchases },
  { prefix: "/admin", title: "Admin", label: "Admin", icon: ICONS.admin },
];

function isActive(pathname: string, prefix: string): boolean {
  if (prefix === "/kits") {
    // The catalog is reachable at both "/" and "/kits".
    return pathname === "/" || pathname === "/kits" || pathname.startsWith("/kits/");
  }
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Market app chrome built on the shared `@agentkitforge/ui` AppShell (sidebar
 * layout). Auth state is resolved server-side and passed in as props so this
 * stays a thin client wrapper. Mirrors the Forge/Auto AppShell pattern.
 *
 * Sidebar nav (href links, active from the current pathname):
 *   Catalog · Submit · My Submissions · Purchases · Organizations ·
 *   Admin (admin only) · Docs (external).
 *
 * The catalog is browsable signed-out — the sidebar renders for everyone; the
 * account slot shows Sign in when there's no session.
 */
export function SiteChrome({
  signedIn,
  userEmail,
  showAdmin,
  selfHost = false,
  ecosystemLinks,
  children,
}: SiteChromeProps) {
  const links = ecosystemLinks ?? {};
  const pathname = usePathname() ?? "/";

  // Local app tabs. Account-scoped tabs (My Submissions, Purchases) are still
  // shown to signed-out users — the routes themselves gate to sign-in. Admin is
  // admin-only.
  const localNav: SidebarNavItem[] = ROUTE_TITLES.filter(
    (r) => r.prefix !== "/admin" || showAdmin,
  ).map((r) => ({
    label: r.label,
    href: r.prefix,
    icon: r.icon,
    active: isActive(pathname, r.prefix),
  }));

  // Organizations now live in AgentKitProfile (the system of record for org
  // management). Surface it as an EXTERNAL link to Profile's /orgs, gated on a
  // Profile URL being configured (self-host without a Profile hides it).
  const nav: SidebarNavItem[] = [...localNav];
  if (links.profileUrl) {
    nav.push({
      label: "Organizations",
      href: `${links.profileUrl}/account/orgs`,
      icon: ICONS.orgs,
      external: true,
    });
  }

  // Docs is an allowed external link (hosted + self-host). Forge/Auto
  // cross-links are intentionally NOT surfaced in the sidebar.
  if (links.docsUrl) {
    nav.push({ label: "Docs", href: `${links.docsUrl}/market/`, icon: ICONS.docs, external: true });
  }

  // Account block: the SHARED standard footer (tile + Sign out only) when signed
  // in — identical across every app; a sign-in link otherwise.
  const account = signedIn ? (
    <SidebarAccountFooter identity={userEmail} accountHref="/submissions" />
  ) : (
    <Link className="ak-btn ak-btn--secondary ak-btn--sm" href="/auth/sign-in">
      Sign in / Create account
    </Link>
  );

  return (
    <AppShell
      layout="app"
      logo={
        <Image
          src="/brand/agentkitmarket-icon.svg"
          alt="AgentKitMarket"
          width={38}
          height={38}
          priority
        />
      }
      brand={
        <>
          AgentKit<span style={{ color: "var(--ak-brand)" }}>Market</span>
        </>
      }
      brandHref="/"
      brandAccent={BRAND_ACCENTS.market.accent}
      brandAccentStrong={BRAND_ACCENTS.market.strong}
      appSwitcher={buildAppSwitcher({ current: "market", links: { forge: links.forgeUrl, auto: links.autoUrl, profile: links.profileUrl } })}
      nav={nav}
      account={account}
      themeToggle
    >
      {children}
    </AppShell>
  );
}
