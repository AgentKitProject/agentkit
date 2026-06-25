# @agentkitforge/ui

Shared UI framework for the AgentKitProject ecosystem. Framework-agnostic React
components + design tokens that run unchanged in **Next.js (App Router)**,
**Vite + Tauri** (desktop Forge), and **Astro React islands**. Each app plugs in
its own logo, brand accent, and nav tabs.

The design foundation is **derived from the desktop Forge app** — the most
polished surface in the ecosystem: Tailwind-slate neutrals, an **indigo-600
brand** with a cyan accent, Inter (UI) + Cascadia Code (mono), 14px cards /
10px controls / 12px nav radii, and a signature `translateY(-1px)` hover lift
with a soft indigo focus ring.

- Plain React — no `next/*` or framework-specific APIs; SSR-safe.
- `react` / `react-dom` are **peer dependencies** (`^18 || ^19`).
- One plain-CSS stylesheet (no CSS modules, no CSS-in-JS); theming via CSS
  custom properties (`ak-`-prefixed).
- Optional Tailwind preset for Tailwind apps.

## Install

```bash
npm install github:AgentKitProject/agentkitforge-ui
# peers (if not already present):
npm install react react-dom
```

## Use

Import the stylesheet **once** (root layout / entry) — required:

```ts
import "@agentkitforge/ui/styles.css";
```

### App surface — `AppShell` (sidebar layout, from desktop Forge)

The **recommended layout for application surfaces** (Forge, Auto, account
dashboards): a sticky left nav rail (logo + nav tabs + account) and a main
column (topbar + content).

```tsx
import { AppShell, SidebarAccount, Card, Button } from "@agentkitforge/ui";

export default function ForgeApp() {
  return (
    <AppShell
      logo={<img src="/icon.svg" alt="" width={42} height={42} />}
      brand="Forge"
      brandSubtitle="Desktop Forge"
      brandAccent="#4f46e5" /* defaults to Forge indigo; one-prop rebrand */
      eyebrow="Agent Kit workspace"
      title="My Kits"
      actions={<Button size="sm">New kit</Button>}
      nav={[
        { label: "My Kits", href: "/", active: true },
        { label: "Build", href: "/build" },
        { label: "Submit to Market", href: "/submit" },
      ]}
      account={<SidebarAccount name="Ada" status="Signed in" initials="A" />}
    >
      <Card title="agentkit-starter">
        <Button>Package</Button>
      </Card>
    </AppShell>
  );
}
```

`nav` items take `href` **or** `onClick` (SPA / Tauri), an optional `icon`
node (e.g. a 18px lucide icon), and `active`. Slots: `logo`, `brand`,
`brandSubtitle`, `nav`/`navChildren`, `account`, `sidebarFooter`,
`eyebrow`/`title`/`actions` (or a fully custom `topbar`).

### Marketing / catalog surface — `SiteShell` (Header + Footer)

For top-chrome web surfaces (project-site, Market landing):

```tsx
import { SiteShell, Card, Button } from "@agentkitforge/ui";

export default function MarketSite() {
  return (
    <SiteShell
      logo={<img src="/logo.svg" alt="Market" height={22} />}
      brand="Market"
      brandAccent="#0fb3d1"
      nav={[
        { label: "Catalog", href: "/", active: true },
        { label: "Submit", href: "/submit" },
        { label: "Docs", href: "/docs", external: true },
      ]}
      account={<Button href="/login" size="sm" variant="secondary">Sign in</Button>}
      footer={{ brandTitle: "AgentKit Market", brandSubtitle: "Discover & share Agent Kits." }}
    >
      <Card title="Featured kit"><Button>Install</Button></Card>
    </SiteShell>
  );
}
```

> **Migrating from the old `AppShell`?** The original header/footer-based
> `AppShell` is now `SiteShell`. `AppShell` defaults to the sidebar layout, but
> accepts `layout="site"` as a back-compat escape hatch that delegates to
> `SiteShell` (same `logo`/`brand`/`nav`/`account`/`footer` props). `Header` and
> `Footer` remain exported and unchanged.

`"use client";` is declared on every interactive component, so they work in the
Next App Router and as Astro islands as well as in Vite/Tauri.

## Rebranding

The **default brand is desktop Forge indigo**. Override the three `--ak-brand*`
vars per app:

| Variable | Default | Notes |
|---|---|---|
| `--ak-brand` | `#4f46e5` | Forge indigo. Market `#0fb3d1`, Auto `#16a34a`, Profile `#2f8f89`. |
| `--ak-brand-strong` | `#4338ca` | Hover / pressed. |
| `--ak-brand-soft` | `#eef2ff` | Tinted surfaces / active nav. |

Three ways:

1. `<AppShell brandAccent="#0fb3d1" />` (one prop, sets the vars on the shell root).
2. `brandVars()` helper for any element: `<div style={brandVars("#16a34a", "#15803d", "#dcfce7")}>`.
3. Plain CSS on your own root, e.g. `:root { --ak-brand: #2f8f89; }`.

Other tokens (overridable, shared by default): `--ak-text`, `--ak-bg`,
`--ak-surface`, `--ak-surface-muted`, `--ak-border`, `--ak-muted`,
`--ak-accent` (cyan), `--ak-success`/`--ak-warning`/`--ak-error`,
`--ak-radius` / `--ak-radius-control` / `--ak-radius-card` / `--ak-radius-nav`,
`--ak-shadow`, `--ak-ring`, `--ak-sidebar` / `--ak-sidebar-active` /
`--ak-sidebar-width`, `--ak-container`, `--ak-font` / `--ak-font-mono`.
**Dark mode:** set `data-theme="dark"` on a wrapper or `<html>` (full slate-950
dark palette, indigo lightened to `#818cf8` for contrast — matching Forge).

## Tailwind preset (optional)

Not required — the stylesheet stands alone. For Tailwind apps that want
token-aware utilities:

```js
// tailwind.config.js
import akPreset from "@agentkitforge/ui/tailwind-preset";
export default { presets: [akPreset], content: ["./src/**/*.{ts,tsx}"] };
```

Exposes `colors.brand{,.strong,.soft}`, `colors.accent`,
`colors.sidebar{,.active}`, `colors.ink/surface/muted/line`,
`borderRadius.ak{,-control,-card,-nav}`, `boxShadow.ak{,-ring}`,
`maxWidth.ak-container`, `fontFamily.ak{,-mono}`, all mapped to the CSS vars.

## Components

| Export | Key props |
|---|---|
| `Button` | `variant` (primary/secondary/ghost/danger), `size` (sm/md), `loading`, `href` (renders `<a>`), `disabled` |
| `Card` | `title`, `header` |
| `Input` / `Textarea` / `Select` / `Field` / `Label` | `label`, `id`, native control props |
| `Badge` (alias `Pill`) | `tone` (brand/success/warning/error/neutral) |
| `AppShell` | sidebar app layout: `logo`, `brand`, `brandSubtitle`, `nav: SidebarNavItem[]`, `account`, `sidebarFooter`, `eyebrow`/`title`/`actions`, `brandAccent`, `layout` (`"app"` default \| `"site"`) |
| `SidebarAccount` | `name`, `status`, `avatar`/`initials`, `href`/`onClick` — the rail account block |
| `SiteShell` | web chrome: `logo`, `brand`, `nav`, `account`, `footer`, `brandAccent` |
| `Header` | `logo`, `brand`, `nav: NavItem[]` or `children`, `account` |
| `Footer` | `brandTitle`, `brandSubtitle`, `links` (override URLs) |
| `brandVars(accent, strong?, soft?)` | returns a style object setting the brand vars |

See `examples/minimal-app.tsx` for both shells side by side.

## Develop

```bash
npm install
npm run build      # tsc emit (JS + d.ts) + copies styles.css into dist/
npm test           # vitest + @testing-library/react (jsdom)
npm run typecheck
```

`prepare` runs the build so `github:`-installs compile `dist/` automatically.
