"use client";

import { type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppShell, BRAND_ACCENTS, buildAppSwitcher, type SidebarNavItem } from "@agentkitforge/ui";
import { SidebarAuth } from "@/components/SidebarAuth";
import type { EcosystemLinks } from "@/lib/self-host";

/** Profile brand mark — flat teal avatar badge, shared flat-2D language. */
function ProfileMark({ size = 38 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="AgentKitProfile"
    >
      <rect x="8" y="8" width="48" height="48" rx="14" fill="#E6F4F2" stroke="#2F8F89" strokeWidth="4" />
      <circle cx="32" cy="27" r="7" fill="#2F8F89" />
      <path d="M20 46 a12 12 0 0 1 24 0 Z" fill="#2F8F89" />
    </svg>
  );
}

// 18px stroke icons for the sidebar nav (no icon dependency), matching the
// market/auto sidebar glyph style.
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const ICONS = {
  // Account overview — user.
  account: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0114 0" />
    </svg>
  ),
  // Profile — id card.
  profile: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="11" r="2" />
      <path d="M6 16a3 3 0 016 0M14.5 10h4M14.5 13.5h4" />
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
  // Security — shield with check.
  security: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  // Products — boxes.
  products: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </svg>
  ),
  // Docs — book.
  docs: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
      <path d="M5 4.5h9a2 2 0 012 2V20a1.5 1.5 0 00-1.5-1.5H5z" />
      <path d="M5 4.5A1.5 1.5 0 003.5 6v13A1.5 1.5 0 015 17.5" />
    </svg>
  ),
} as const;

/** Account-hub routes and their sidebar labels/icons. */
const ROUTES: { prefix: string; label: string; icon: ReactNode; exact?: boolean }[] = [
  { prefix: "/account", label: "Account", icon: ICONS.account, exact: true },
  { prefix: "/account/profile", label: "Profile", icon: ICONS.profile },
  { prefix: "/account/orgs", label: "Organizations", icon: ICONS.orgs },
  { prefix: "/account/security", label: "Security", icon: ICONS.security },
  { prefix: "/account/products", label: "Products", icon: ICONS.products },
];

function isActive(pathname: string, prefix: string, exact?: boolean): boolean {
  if (exact) return pathname === prefix;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Profile app chrome on the shared `@agentkitforge/ui` AppShell (sidebar layout),
 * mirroring Forge/Auto/Market so all surfaces look identical. Replaces the older
 * SiteShell top-nav + per-page AccountShell sidebar (the "historical" mix).
 *
 * Sidebar nav: Account · Profile · Organizations · Security · Products, plus a
 * single external Docs link. Organizations is INTERNAL here — Profile is the
 * system of record for org management.
 */
export function SiteChrome({
  ecosystemLinks,
  children,
}: {
  ecosystemLinks?: EcosystemLinks;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "/";

  const nav: SidebarNavItem[] = ROUTES.map((r) => ({
    label: r.label,
    href: r.prefix,
    icon: r.icon,
    active: isActive(pathname, r.prefix, r.exact),
  }));

  // Docs is the single allowed external link (hosted + self-host). Resolved
  // server-side via ecosystemLinks; default to the public docs site.
  const docsUrl = ecosystemLinks?.docsUrl ?? "https://docs.agentkitproject.com";
  nav.push({ label: "Docs", href: `${docsUrl}/profile/`, icon: ICONS.docs, external: true });

  return (
    <AppShell
      layout="app"
      logo={<ProfileMark size={38} />}
      brand={
        <>
          AgentKit<span style={{ color: "var(--ak-brand)" }}>Profile</span>
        </>
      }
      brandHref="/"
      brandAccent={BRAND_ACCENTS.profile.accent}
      brandAccentStrong={BRAND_ACCENTS.profile.strong}
      appSwitcher={buildAppSwitcher({ current: "profile", links: { forge: ecosystemLinks?.forgeUrl, market: ecosystemLinks?.marketUrl, auto: ecosystemLinks?.autoUrl } })}
      nav={nav}
      account={<SidebarAuth />}
      themeToggle
    >
      {children}
    </AppShell>
  );
}
