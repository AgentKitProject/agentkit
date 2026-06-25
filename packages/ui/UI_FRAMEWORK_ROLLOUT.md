# `@agentkitforge/ui` — Shared UI Framework Rollout

One tokens + components + shell framework for **every** surface in the
AgentKitProject ecosystem (web + desktop), giving a consistent look and shared
cross-nav, while each app plugs in its own logo, brand accent, and tabs.

This document is the canonical plan **and** the migration recipe. It reflects
the framework as built today, the per-app theming hook, and the step-by-step
recipe for adopting (or re-aligning) any surface.

---

## 0. Current state (as built)

The package is **complete and already consumed by all six surfaces.** This is
not a green-field plan — it documents the established framework and the recipe
to keep new/changed surfaces aligned.

| Surface | Stack | Shell used | Theming hook | Status |
|---|---|---|---|---|
| `apps/profile-web` | Next 15 | `SiteShell` (via `SiteChrome`) | teal bridge in `globals.css` + `brandAccent` | adopted |
| `apps/market-web` | Next 15 | `SiteShell` (via `SiteChrome`) | cyan bridge in `globals.css` + `brandAccent` | adopted |
| `apps/forge-web` | Next 15 | `AppShell` (sidebar) | `forge.css` bridge + `data-theme` no-flash script | adopted |
| `apps/auto-web` | Next 15 | `AppShell` (sidebar) | `forge.css` bridge + `data-theme` no-flash script | adopted |
| `apps/forge-desktop` | Vite + Tauri | `AppShell` (sidebar) | `styles.css` bridge | adopted |
| `apps/site` | Astro 5 | hand-rendered `ak-*` classes (no React island) | `BaseLayout.astro` bridge + `theme-*` body class | adopted |

**Verified in this increment:** `packages/ui` builds (`tsc` + css copy),
typechecks, and its **test suite passes (16/16)** — the suite was previously
broken under vitest 4 and was fixed (see §6). `profile-web` typechecks clean
against the package.

---

## 1. Token system (single source of truth)

All design tokens are CSS custom properties (`--ak-*`) defined in
`src/styles/styles.css`, light theme on `:root`, dark under
`[data-theme="dark"]`. Apps import the stylesheet **once** and theme by
overriding a small number of vars.

**Foundation:** derived from the desktop Forge app (the most polished surface):
Tailwind-slate neutrals, indigo-600 default brand, cyan accent, Inter (UI) +
Cascadia Code (mono), 14/10/12px card/control/nav radii, and a signature
`translateY(-1px)` hover lift + soft focus ring.

Token groups:

- **Text / surfaces:** `--ak-text`, `--ak-bg`, `--ak-surface`,
  `--ak-surface-muted`, `--ak-border`, `--ak-muted`
- **Status:** `--ak-success`, `--ak-warning`, `--ak-error`
- **Brand (the per-app knob):** `--ak-brand`, `--ak-brand-strong`,
  `--ak-brand-soft`
- **Secondary accent:** `--ak-accent` (cyan)
- **Sidebar:** `--ak-sidebar`, `--ak-sidebar-active`, `--ak-sidebar-width`
- **Geometry:** `--ak-radius{,-control,-card,-nav}`, `--ak-shadow{,-sm}`,
  `--ak-ring{,-soft}`, `--ak-container`
- **Type / motion:** `--ak-font`, `--ak-font-mono`, `--ak-transition`

**Dark mode:** set `data-theme="dark"` on `<html>` (or any wrapper). Web apps
that support a theme toggle run a tiny pre-hydration inline script that reads
`localStorage("akf-theme")` (falling back to the OS preference) and sets
`data-theme` before React paints — preventing a flash. See `forge-web` /
`auto-web` `layout.tsx`.

---

## 2. Core component set

Exported from `src/index.ts`, all plain React with `"use client"` on
interactive pieces (SSR-safe; work in Next App Router, Vite/Tauri, and Astro
islands). `react`/`react-dom` are peer deps.

| Export | Purpose |
|---|---|
| `AppShell`, `SidebarAccount` | **App surface** layout: sidebar rail (logo + nav tabs + account) + topbar + content. Default `layout="app"`; `layout="site"` delegates to `SiteShell`. |
| `SiteShell` | **Marketing/catalog surface** layout: sticky `Header` + `Footer` chrome. |
| `Header`, `Footer` | Lower-level chrome used by `SiteShell` (also exported for hand-composed surfaces such as the Astro site). |
| `Button` | `variant` (primary/secondary/ghost/danger), `size` (sm/md), `loading`, `href` → `<a>`. |
| `Card` | `title` / custom `header`. |
| `Field`, `Label`, `Input`, `Textarea`, `Select` | Form primitives. |
| `Badge` (alias `Pill`) | `tone` (brand/success/warning/error/neutral). |
| `DEFAULT_NAV`, `navWithActive` | Pure-data ecosystem cross-nav (no `"use client"`, RSC/Astro-safe). |
| `DEFAULT_FOOTER_LINKS` | Shared ecosystem + legal footer link set; contact `hello@agentkit-project.com`. |
| `brandVars(accent, strong?, soft?)` | Inline-style helper that sets the three `--ak-brand*` vars. |
| `BRAND_ACCENTS` / `BrandKey` | Canonical per-app accents (`forge`/`market`/`auto`/`profile`/`site`), each `{ accent, strong }`. Apps reference these instead of hardcoding hex. |
| `ThemeToggle` | Built-in dark-mode toggle (`variant="icon"` for SiteShell header, `variant="nav"` for AppShell sidebar). Owns the FOUC-safe persist logic. |
| `themeInitScript()` / `useTheme()` / `THEME_STORAGE_KEY` | FOUC-free pre-paint `<head>` script (server-safe), the shared theme hook, and the `akf-theme` storage key. |

**Cross-nav is the load-bearing shared piece.** `DEFAULT_NAV` is the single
source of truth for the ecosystem tab list (Home / Forge / Web Forge / Auto /
Market / Docs / Roadmap / Account) with correct same-tab vs. new-tab behavior.
Every marketing surface renders `navWithActive("<its label>")` so the cross-nav
is identical everywhere and each site highlights its own tab.

---

## 3. The two shells

Pick by surface type:

- **`AppShell` (sidebar)** — application surfaces with persistent nav: Forge
  (desktop + web), Auto, signed-in dashboards. Slots: `logo`, `brand`,
  `brandSubtitle`, `nav: SidebarNavItem[]` (or `navChildren`), `account`
  (use `SidebarAccount`), `sidebarFooter`, `eyebrow`/`title`/`actions` (or a
  fully custom `topbar`). `nav` items take `href` **or** `onClick` (for
  SPA/Tauri), an optional `icon`, and `active`.
- **`SiteShell` (header + footer)** — marketing/catalog surfaces: project site,
  Market catalog, Profile account chrome. Slots: `logo`, `brand`, `nav`,
  `account`, `footer`.

Both accept a one-prop rebrand (`brandAccent`, optional `brandAccentStrong` /
`brandAccentSoft`) that sets the brand vars on the shell root.

---

## 4. Per-app theming hook (one knob, three ways)

The default brand is Forge indigo. Each app sets its own accent — **one knob,
three equivalent mechanisms:**

1. **Shell prop (preferred for a single mounted shell):**
   `<AppShell brandAccent="#0fb3d1" />` / `<SiteShell brandAccent="#2f8f89" />`.
2. **`brandVars()` on any element:**
   `<div style={brandVars("#16a34a", "#15803d", "#dcfce7")}>`.
3. **CSS on the app root (preferred when the app also bridges legacy tokens):**
   override `--ak-brand{,-strong,-soft}` in `globals.css` / `forge.css` /
   `BaseLayout.astro`. This is what the adopted apps do, because it also lets a
   **token bridge** alias each app's pre-existing token names onto the shared
   `--ak-*` tokens (so existing Tailwind utilities like `text-[var(--brand)]`
   keep working unchanged against the single palette).

**Canonical per-app accents (proposed — see Open Questions):**

| App | `--ak-brand` | `--ak-brand-strong` |
|---|---|---|
| Forge (desktop + web) | `#4f46e5` (indigo) | `#4338ca` |
| Market | `#0fb3d1` (cyan) | `#0b8ba6` |
| Auto | `#16a34a` (green) | `#15803d` |
| Profile | `#2f8f89` (teal) | `#24736e` |
| Project site | `#6d46e9` (purple) | `#5a36c9` |

---

## 5. Migration recipe (per surface)

The recipe below is what the adopted apps already follow; use it for any new
surface or to re-align one that drifts.

### 5a. Next.js App Router — marketing/catalog surface (`SiteShell`)

_Reference: `apps/market-web`, `apps/profile-web`._

1. **Dependency:** add `"@agentkitforge/ui": "workspace:*"`.
2. **Transpile:** `next.config.ts` → `transpilePackages: ["@agentkitforge/ui"]`
   (the package ships ESM source; Next must transpile it).
3. **Stylesheet:** in `app/globals.css`, **first** line
   `@import "@agentkitforge/ui/styles.css";` then `@import "tailwindcss";`.
4. **Token bridge + brand:** in `:root`, set `--ak-brand{,-strong,-soft}` to the
   app accent and alias any legacy app token names to `--ak-*` (so existing
   utilities keep working). Add app-only flourishes (e.g. a brand gradient
   background) here, not in the framework.
5. **Chrome wrapper:** create a `components/SiteChrome.tsx` (`"use client"`) that
   renders `<SiteShell brandAccent=… logo={<AppLogo/>}
   nav={navWithActive("<label>")} account={<AuthNav/>} footer={…}>` and wrap
   `children` with it in `app/layout.tsx` (inside any auth provider).
6. **Auth/account slot:** keep the app's own auth nav (session fetch, sign-in /
   sign-out) in the `account` slot — the shell does not own auth.
7. **Footer:** start from `DEFAULT_FOOTER_LINKS`; override only the app-local
   routes (privacy/terms/etc.) via the `footer.links` prop.
8. **Verify:** `npm run typecheck` and `npm run build`.

### 5b. Next.js App Router — application surface (`AppShell`)

_Reference: `apps/forge-web`, `apps/auto-web`._

Same steps 1–2 and 8, plus:

3. **Stylesheet:** import `@agentkitforge/ui/styles.css` first in `layout.tsx`,
   then the app's `forge.css`.
4. **No-flash theme:** add the inline `THEME_INIT_SCRIPT` to `<head>` and
   `suppressHydrationWarning` on `<html>` if the app has a dark-mode toggle.
5. **Shell:** render `<AppShell layout="app" brandAccent=… logo brand nav={[…]}
   account={<SidebarAccount … />} eyebrow title actions>` from a client root
   component; pass `onClick` nav items for SPA section switching.

### 5c. Vite + Tauri desktop (`AppShell`)

_Reference: `apps/forge-desktop`._

- Import `@agentkitforge/ui/styles.css` then `./styles.css` in `main.tsx`.
- Use `AppShell` with `onClick` nav items (no router); `SidebarAccount` for the
  account block. This is the surface the framework's visual language is derived
  from, so it is the reference for spacing/radii/interaction.
- **Caveat:** desktop has no `next/*`; everything stays plain React (already the
  framework's contract). Keep OS-shell concerns (deep links, secure storage,
  updater) in Rust — unrelated to UI.

### 5d. Astro site (hand-rendered chrome)

_Reference: `apps/site/src/layouts/BaseLayout.astro`._

- The React shells are **not** used here. The site imports
  `@agentkitforge/ui/styles.css` and `{ DEFAULT_NAV, navWithActive }` (pure
  data — RSC/Astro-safe because `nav.ts` has no `"use client"`), then renders
  the `ak-header` / `ak-footer` / `ak-btn` classes by hand in `.astro` markup.
- **Caveat / rationale:** the marketing site is largely no-JS and multi-themed
  per section (`theme-forge`/`-market`/`-auto` body classes flip `--ak-brand*`),
  so hand-rendered chrome avoids shipping a React island just for the header.
  The shared **classes and tokens** still guarantee visual parity.
- If a future Astro page wants interactivity (e.g. the mobile hamburger), mount
  `Header`/`Footer` as a `client:load` React island instead.

---

## 6. Fixed in this increment

- **Broken test suite (`packages/ui`).** Under vitest 4 + jest-dom 6.9, the
  auto-extending `@testing-library/jest-dom/vitest` setup entry extended an
  `expect` instance that did not match the one the runner used, so every
  matcher (`toHaveClass`, `toBeDisabled`, …) failed with
  `Invalid Chai property`. `test/setup.ts` now imports
  `@testing-library/jest-dom/matchers` and calls `expect.extend(matchers)`
  against the `vitest` `expect` explicitly. Result: **16/16 passing.**

---

## 7. Open questions for the maintainer

These cross-app design decisions are currently encoded by convention and should
be confirmed (or centralized) rather than left implicit:

1. ~~**Brand accents (the table in §4).**~~ **Resolved:** the canonical accents
   now live as the `BRAND_ACCENTS` named export (`{ accent, strong }` per app)
   and the four Next apps reference them via the shells' `brandAccent`/
   `brandAccentStrong` props instead of hardcoding hex. The dark-mode toggle is
   likewise centralized: apps enable the shells' built-in `themeToggle` and the
   per-app `ThemeToggle.tsx` files were removed.
2. **Logo ownership.** Logos are bespoke per app (inline SVG / `next/image`).
   Confirm they stay app-owned (the framework only provides the slot), vs.
   shipping a small `logos/` set from the package.
3. **Cross-nav tab set.** `DEFAULT_NAV` currently is Home / Forge / Web Forge /
   Auto / Market / Docs / Roadmap / Account. Confirm this is the canonical set
   and that the same-tab vs. new-tab (`external`) policy is right.
4. **Astro parity strategy.** Keep hand-rendered chrome (no island) on the
   marketing site, or move to React islands for the header/footer so there is a
   single rendering path? Trade-off is a JS payload vs. one source of truth.
5. **Package versioning/publish.** The package is `0.0.1`, workspace-internal.
   When is it cut to a published, semver-stable release, given all six surfaces
   depend on it (any change is effectively a fleet-wide change)?
