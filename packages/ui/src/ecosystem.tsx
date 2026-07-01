// Standard cross-app switcher data for the AppShell. Centralizes the canonical
// app list (order, labels, glyphs) so every app renders the SAME switcher; each
// app just passes its server-resolved ecosystem links + which app is current.
//
// Self-host aware by construction: an app only appears if a link is configured
// for it (operator sets NEXT_PUBLIC_<APP>_URL for the apps they deployed). The
// current app always appears (linking to its own home).

import * as React from "react";
import type { SidebarNavItem } from "./components/AppShell.js";

export type EcosystemAppId = "forge" | "market" | "auto" | "profile";

/** Server-resolved absolute URLs for the ecosystem apps (any may be absent). */
export type EcosystemLinks = Partial<Record<EcosystemAppId, string | undefined>>;

const glyph = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const GLYPHS: Record<EcosystemAppId, React.ReactNode> = {
  // Forge — line cube.
  forge: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...glyph}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </svg>
  ),
  // Market — tile grid.
  market: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...glyph}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
    </svg>
  ),
  // Auto — hexagon.
  auto: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...glyph}>
      <path d="M12 3l7.5 4.3v8.6L12 21l-7.5-4.1V7.3z" />
    </svg>
  ),
  // Profile — avatar.
  profile: (
    <svg viewBox="0 0 24 24" width={18} height={18} {...glyph}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0114 0" />
    </svg>
  ),
};

const APP_ORDER: { id: EcosystemAppId; label: string }[] = [
  { id: "forge", label: "Forge" },
  { id: "market", label: "Market" },
  { id: "auto", label: "Auto" },
  { id: "profile", label: "Profile" },
];

/**
 * Build the standard app-switcher items for the AppShell `appSwitcher` prop.
 * The current app links to "/" (marked active); every other app appears only
 * if a link is configured for it.
 */
export function buildAppSwitcher({
  current,
  links,
}: {
  current: EcosystemAppId;
  links: EcosystemLinks;
}): SidebarNavItem[] {
  return APP_ORDER.flatMap((app): SidebarNavItem[] => {
    if (app.id === current) {
      return [{ label: app.label, href: "/", icon: GLYPHS[app.id], active: true }];
    }
    const href = links[app.id];
    if (!href) return [];
    return [{ label: app.label, href, icon: GLYPHS[app.id], external: true }];
  });
}
