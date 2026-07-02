// Canonical ecosystem navigation — PURE data + helpers, no React, NO "use client".
//
// This lives in its own module (not Header.tsx) on purpose: Header.tsx carries a
// "use client" directive, and a React Server Component that imports from a client
// module receives client *references*, not the real array — so `DEFAULT_NAV.map`
// would crash at render. Keeping the nav data here lets ANY consumer (RSC, client
// component, or an Astro frontmatter import) read the real values. Single source
// of truth for the tabs every marketing surface renders.

export type NavItem = {
  label: string;
  href: string;
  external?: boolean;
  active?: boolean;
};

/**
 * The shared header nav rendered across ALL AgentKitProject marketing surfaces
 * (project-site, Forge site, Market, Profile). Each site renders this and marks
 * its OWN tab active (see `navWithActive`), and may append page-specific items.
 * Absolute URLs so the same nav works from any site.
 *
 * `external: true` is set ONLY on true web-app destinations (Forge, Auto,
 * Account) that the user expects to open as a persistent session in their current
 * tab — launching them in a new tab avoids displacing the marketing page they are
 * on. Static/marketing destinations (Home, Market catalog, Docs, Roadmap) do NOT
 * set `external` so they navigate in the same tab as expected.
 */
export const DEFAULT_NAV: NavItem[] = [
  { label: "Home", href: "https://agentkitproject.com" },
  { label: "Forge", href: "https://forge.agentkitproject.com", external: true },
  {
    label: "Auto",
    href: "https://auto.agentkitproject.com",
    external: true,
  },
  { label: "Market", href: "https://market.agentkitproject.com" },
  { label: "Docs", href: "https://docs.agentkitproject.com" },
  { label: "Roadmap", href: "https://agentkitproject.com/roadmap" },
  { label: "Account", href: "https://profile.agentkitproject.com", external: true },
];

/**
 * Returns the canonical nav (or a custom list) with the item whose label matches
 * `activeLabel` marked active — the standard way for a site to highlight its own
 * tab. Pass `items` to append page-specific entries before highlighting.
 */
export function navWithActive(
  activeLabel: string,
  items: NavItem[] = DEFAULT_NAV,
): NavItem[] {
  return items.map((it) => ({ ...it, active: it.label === activeLabel }));
}
