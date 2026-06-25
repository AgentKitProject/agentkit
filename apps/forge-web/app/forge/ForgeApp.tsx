"use client";

// Web Forge UI — shell + section router.
//
// ForgeApp is now a thin shell: it owns the sidebar nav, topbar, deep-link
// routing, global state (kits, favorites, usage, toast, theme) and delegates
// each section to a dedicated component under ./sections/. The WebForgeClient
// seam is unchanged — all HTTP calls still go through forge-client/web-client.ts.

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell, SidebarAccount, type SidebarNavItem } from "@agentkitforge/ui";
import { getForgeClient } from "@/forge-client";
import type { MyKitEntry } from "@/forge-client";
import {
  ExportIcon,
  ForgeMark,
  HammerIcon,
  ImportIcon,
  InfoIcon,
  PackageIcon,
  PlayIcon,
  PlugIcon,
  SettingsIcon,
  SparklesIcon,
  UploadIcon,
  UserIcon
} from "./icons";
import { AutoLogo } from "./sections/AutoLogo";
import type { Favorite, PublicConfig, SessionUser, UsageInfo } from "./sections/shared";
import { ConfigProvider } from "./config-context";
import { errMsg, fmtBytes } from "./sections/shared";
import { MyKits } from "./sections/MyKits";
import { BuildSection } from "./sections/BuildSection";
import { UseSection } from "./sections/UseSection";
import { RunSection } from "./sections/RunSection";
import { ImportSection } from "./sections/ImportSection";
import { PackageExportSection } from "./sections/PackageExportSection";
import { MarketSubmitSection, SubmitModal } from "./sections/MarketSubmitSection";
import { KitEditor } from "./sections/KitEditor";
import { SettingsSection } from "./sections/SettingsSection";
import { AccountSection } from "./sections/AccountSection";
import { AboutSection } from "./sections/AboutSection";
import { InstallTargetsSection } from "./sections/InstallTargetsSection";
import { type SectionId, isValidSectionId } from "./section-ids";

type Forge = ReturnType<typeof getForgeClient>;

type NavDef = { id: SectionId; label: string; icon: ReactNode };

const NAV: NavDef[] = [
  { id: "my-kits", label: "My Kits", icon: <PackageIcon size={18} /> },
  { id: "build", label: "Build", icon: <HammerIcon size={18} /> },
  { id: "use", label: "Use", icon: <PlayIcon size={18} /> },
  { id: "run", label: "Run / Chat", icon: <SparklesIcon size={18} /> },
  { id: "import", label: "Import", icon: <ImportIcon size={18} /> },
  { id: "package-export", label: "Package / Export", icon: <ExportIcon size={18} /> },
  { id: "install-targets", label: "Install Targets", icon: <PlugIcon size={18} /> },
  { id: "market-submit", label: "Submit to Market", icon: <UploadIcon size={18} /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon size={18} /> },
  { id: "about", label: "About", icon: <InfoIcon size={18} /> }
];

const SECTION_TITLES: Record<SectionId, { eyebrow: string; title: string }> = {
  "my-kits": { eyebrow: "Library", title: "My Kits" },
  build: { eyebrow: "Create", title: "Build an Agent Kit" },
  use: { eyebrow: "Run", title: "Use a Kit" },
  run: { eyebrow: "Run", title: "Chat with a Kit" },
  import: { eyebrow: "Bring in", title: "Import a Kit" },
  "package-export": { eyebrow: "Distribute", title: "Package / Export" },
  "install-targets": { eyebrow: "Deploy", title: "Install Targets" },
  "market-submit": { eyebrow: "Publish", title: "Submit to Market" },
  settings: { eyebrow: "Configure", title: "Settings" },
  account: { eyebrow: "Account", title: "Your AgentKitProject account" },
  about: { eyebrow: "About", title: "About AgentKitForge" }
};

function initials(email?: string): string {
  if (!email) return "";
  const name = email.split("@")[0];
  const parts = name.split(/[._-]+/).filter(Boolean);
  return (parts[0]?.[0] ?? name[0] ?? "").concat(parts[1]?.[0] ?? "").toUpperCase();
}

// Persisted theme: reads/writes localStorage "akf-theme"
function useTheme(): [string, () => void] {
  // Default to "light" for the FIRST render on BOTH server and client so the
  // server-rendered HTML matches the client's initial render (no React #418
  // hydration mismatch). The real persisted/system theme is read AFTER mount
  // in the effect below (a pure client update, no hydration involved). The
  // inline script in app/layout.tsx sets data-theme pre-paint to avoid a flash.
  const [theme, setTheme] = useState<string>("light");

  useEffect(() => {
    const saved =
      localStorage.getItem("akf-theme") ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(saved);
  }, []);

  // Skip the first render (theme="light" placeholder): the inline layout script
  // already set the correct data-theme pre-paint, so applying "light" here would
  // cause a one-frame flash before the real theme loads. Apply on every change after.
  const themeSynced = useRef(false);
  useEffect(() => {
    if (!themeSynced.current) {
      themeSynced.current = true;
      return;
    }
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("akf-theme", theme);
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}

export default function ForgeApp({ user, config }: { user: SessionUser; config: PublicConfig }) {
  const forge: Forge = useMemo(() => getForgeClient(), []);
  const [section, setSection] = useState<SectionId>("my-kits");
  const [kits, setKits] = useState<MyKitEntry[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [openKitId, setOpenKitId] = useState<string | null>(null);
  const [submitKitId, setSubmitKitId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [usage, setUsage] = useState<UsageInfo>(null);
  const [theme, toggleTheme] = useTheme();

  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast(null), 4200);
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/me/usage", { credentials: "include" });
      if (res.ok) setUsage((await res.json()) as UsageInfo);
    } catch {
      // non-critical
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [k, favRes] = await Promise.all([
        forge.listMyKits(),
        fetch("/api/favorites", { credentials: "include" }).then((r) => r.json())
      ]);
      setKits(k);
      setFavorites(((favRes as { favorites?: Favorite[] }).favorites ?? []) as Favorite[]);
    } catch (e) {
      notify(errMsg(e), true);
    }
    await refreshUsage();
  }, [forge, notify, refreshUsage]);

  useEffect(() => {
    void refresh();
    // Deep-link: ?import=<slug> jumps to Import section
    void forge.getInitialDeepLinks().then((links) => {
      const url = links[0];
      if (url && new URL(url).searchParams.get("import")) setSection("import");
    });
    // Deep-link: ?section=<id> jumps to any valid section.
    const sectionParam = new URLSearchParams(window.location.search).get("section");
    if (sectionParam === "auto") {
      // Auto is now a standalone app; the legacy embedded section is gone.
      // Redirect the old deep link to the standalone Auto app when one is
      // configured (always on hosted; self-host only if NEXT_PUBLIC_AUTO_URL set).
      if (config.links.autoUrl) {
        window.location.replace(config.links.autoUrl);
        return;
      }
    }
    // Don't honor the Market-submit deep link when Market is disabled.
    if (sectionParam === "market-submit" && !config.marketEnabled) {
      return;
    }
    if (sectionParam && isValidSectionId(sectionParam)) {
      setSection(sectionParam);
    }
    // Apply persisted theme immediately on mount
    const saved = typeof window !== "undefined" ? localStorage.getItem("akf-theme") : null;
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  }, [forge, refresh, config.links.autoUrl, config.marketEnabled]);

  const heading = openKitId
    ? { eyebrow: "Edit", title: "Kit editor" }
    : SECTION_TITLES[section];

  // Declarative nav for the framework AppShell. Selecting a section also clears
  // any open kit editor (preserving the original click behavior). When Market is
  // disabled (self-host without a Market) the "Submit to Market" tab is hidden.
  const visibleNav = config.marketEnabled ? NAV : NAV.filter((n) => n.id !== "market-submit");
  const navItems: SidebarNavItem[] = visibleNav.map(({ id, label, icon }) => ({
    label,
    icon,
    active: section === id && !openKitId,
    onClick: () => {
      setOpenKitId(null);
      setSection(id);
    }
  }));

  // Auto is a standalone app: render it as a link-out (new tab) in the rail
  // rather than an embedded section. Keep the official AgentKitAuto icon.
  // Insert just after "Run / Chat" to preserve its historical position. Hidden
  // on self-host unless an Auto URL is configured (no link back into our
  // ecosystem by default).
  if (config.links.autoUrl) {
    const autoNavItem: SidebarNavItem = {
      label: "Auto",
      icon: <AutoLogo size={18} title="" aria-hidden />,
      href: config.links.autoUrl,
      external: true
    };
    const runIdx = navItems.findIndex((n) => n.label === "Run / Chat");
    navItems.splice(runIdx >= 0 ? runIdx + 1 : navItems.length, 0, autoNavItem);
  }

  // Theme toggle + account block pinned to the bottom of the rail.
  const sidebarFooter = (
    <button
      type="button"
      className="ak-nav-item"
      style={{ fontSize: "0.82em", opacity: 0.8 }}
      onClick={toggleTheme}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      <span className="ak-nav-item__icon" aria-hidden="true">
        {theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      </span>
      <span className="ak-nav-item__label">{theme === "dark" ? "Light mode" : "Dark mode"}</span>
    </button>
  );

  const usageNode =
    usage && !openKitId ? (
      <div style={{ fontSize: "0.8em", color: "var(--color-text-secondary)", textAlign: "right" }}>
        {usage.kitCount}/{usage.kitLimit} kits · {fmtBytes(usage.bytes)}/{fmtBytes(usage.byteLimit)}
        {usage.kitCount >= usage.kitLimit && <span style={{ color: "var(--color-error)", marginLeft: 6 }}>Limit reached</span>}
      </div>
    ) : null;

  return (
    <ConfigProvider value={config}>
      <AppShell
        logo={<ForgeMark size={38} aria-hidden="true" />}
        brand={
          <>
            AgentKit<span style={{ color: "var(--ak-brand)" }}>Forge</span>
          </>
        }
        brandSubtitle="Web Forge"
        brandAccent="#4f46e5"
        nav={navItems}
        account={
          <SidebarAccount
            name={user?.email ?? "Signed in"}
            status="AgentKitProject account"
            initials={initials(user?.email)}
            avatar={initials(user?.email) ? undefined : <UserIcon size={18} />}
            onClick={() => {
              setOpenKitId(null);
              setSection("account");
            }}
            className={section === "account" && !openKitId ? "ak-sidebar__account--active" : undefined}
          />
        }
        sidebarFooter={sidebarFooter}
        eyebrow={heading.eyebrow}
        title={heading.title}
        actions={usageNode}
      >
        {openKitId ? (
            <KitEditor forge={forge} kitId={openKitId} notify={notify} onClose={() => { setOpenKitId(null); void refresh(); }} />
          ) : section === "my-kits" ? (
            <MyKits
              forge={forge}
              kits={kits}
              favorites={favorites}
              usage={usage}
              notify={notify}
              onOpen={(id) => setOpenKitId(id)}
              onSubmit={(id) => setSubmitKitId(id)}
              onBuild={() => setSection("build")}
              onImport={() => setSection("import")}
              onRefresh={refresh}
            />
          ) : section === "build" ? (
            <BuildSection forge={forge} notify={notify} kits={kits} onOpen={(id) => { void refresh(); setOpenKitId(id); }} />
          ) : section === "use" ? (
            <UseSection forge={forge} kits={kits} notify={notify} />
          ) : section === "run" ? (
            <RunSection forge={forge} kits={kits} notify={notify} />
          ) : section === "import" ? (
            <ImportSection forge={forge} notify={notify} onDone={(kitId) => { void refresh().then(() => { setSection("my-kits"); if (kitId) setOpenKitId(kitId); }); }} />
          ) : section === "package-export" ? (
            <PackageExportSection forge={forge} kits={kits} notify={notify} />
          ) : section === "install-targets" ? (
            <InstallTargetsSection forge={forge} kits={kits} notify={notify} />
          ) : section === "market-submit" && config.marketEnabled ? (
            <MarketSubmitSection kits={kits} onPick={(id) => setSubmitKitId(id)} />
          ) : section === "settings" ? (
            <SettingsSection forge={forge} notify={notify} />
          ) : section === "account" ? (
            <AccountSection user={user} />
          ) : (
            <AboutSection forge={forge} />
          )}
      </AppShell>

      {submitKitId && config.marketEnabled && (
        <SubmitModal forge={forge} kitId={submitKitId} notify={notify} onClose={() => setSubmitKitId(null)} />
      )}
      {toast && <div className={`akf-toast${toast.err ? " err" : ""}`}>{toast.msg}</div>}
    </ConfigProvider>
  );
}

// Minimal inline theme icons to avoid adding a dep
function SunIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="10" cy="10" r="3.5" />
      <line x1="10" y1="2" x2="10" y2="4" />
      <line x1="10" y1="16" x2="10" y2="18" />
      <line x1="2" y1="10" x2="4" y2="10" />
      <line x1="16" y1="10" x2="18" y2="10" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="14.36" y1="14.36" x2="15.78" y2="15.78" />
      <line x1="4.22" y1="15.78" x2="5.64" y2="14.36" />
      <line x1="14.36" y1="5.64" x2="15.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M17 11.5A7 7 0 1 1 8.5 3a5.5 5.5 0 1 0 8.5 8.5z" />
    </svg>
  );
}
