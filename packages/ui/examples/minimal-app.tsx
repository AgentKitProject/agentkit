// Two layouts from one foundation (design-language derived from desktop Forge):
//   • AppShell  — sidebar app layout (logo + nav rail + topbar). Recommended
//     for app surfaces (Forge, Auto, account dashboards).
//   • SiteShell — top-chrome web layout (Header + Footer) for marketing /
//     catalog surfaces (project-site, Market landing).
// Both work unchanged in Next (App Router), Vite + Tauri, or as Astro islands.
import "@agentkitforge/ui/styles.css";
import {
  AppShell,
  SiteShell,
  SidebarAccount,
  Card,
  Button,
  Badge,
} from "@agentkitforge/ui";

/* ----- App surface: desktop-Forge-style sidebar shell ------------------ */
export function ForgeApp() {
  return (
    <AppShell
      logo={<img src="/agentkitforge-icon.svg" alt="" width={42} height={42} />}
      brand="Forge"
      brandSubtitle="Desktop Forge"
      brandHref="/"
      /* default brand is Forge indigo; override per app with one prop */
      brandAccent="#4f46e5"
      eyebrow="Agent Kit workspace"
      title="My Kits"
      actions={<Button size="sm">New kit</Button>}
      nav={[
        { label: "My Kits", href: "/", active: true },
        { label: "Build", href: "/build" },
        { label: "Run / Chat", href: "/run" },
        { label: "Submit to Market", href: "/submit" },
        { label: "Settings", href: "/settings" },
      ]}
      account={
        <SidebarAccount name="Ada Lovelace" status="Signed in" initials="AL" />
      }
    >
      <Card title="agentkit-starter">
        <p>
          A portable bundle of AI instructions, skills, and policies.{" "}
          <Badge tone="success">verified</Badge>
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <Button>Package</Button>
          <Button variant="secondary">Validate</Button>
          <Button variant="ghost">Export</Button>
        </div>
      </Card>
    </AppShell>
  );
}

/* ----- Marketing / catalog surface: web chrome (Header + Footer) ------- */
export function MarketSite() {
  return (
    <SiteShell
      logo={<img src="/logo.svg" alt="" height={22} />}
      brand="Market"
      brandAccent="#0fb3d1" /* rebrand with one prop */
      nav={[
        { label: "Catalog", href: "/", active: true },
        { label: "Submit", href: "/submit" },
        { label: "Docs", href: "/docs", external: true },
      ]}
      account={
        <Button href="/login" size="sm" variant="secondary">
          Sign in
        </Button>
      }
      footer={{
        brandTitle: "AgentKit Market",
        brandSubtitle: "Discover, share, and install Agent Kits.",
      }}
    >
      <Card title="Featured kit">
        <Button>Install</Button>
      </Card>
    </SiteShell>
  );
}

export default ForgeApp;
