"use client";

// Web Forge UI — shell + section router.
//
// ForgeApp is now a thin shell: it owns the sidebar nav, topbar, deep-link
// routing, global state (kits, favorites, usage, toast, theme) and delegates
// each section to a dedicated component under ./sections/. The WebForgeClient
// seam is unchanged — all HTTP calls still go through forge-client/web-client.ts.

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell, SidebarAccountFooter, BRAND_ACCENTS, buildAppSwitcher, type SidebarNavItem } from "@agentkitforge/ui";
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
  UploadIcon
} from "./icons";
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
  { id: "use", label: "Prepared prompts", icon: <PlayIcon size={18} /> },
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
  use: { eyebrow: "Prepared prompts", title: "Prepared prompts" },
  run: { eyebrow: "Run", title: "Chat with a Kit" },
  import: { eyebrow: "Bring in", title: "Import a Kit" },
  "package-export": { eyebrow: "Distribute", title: "Package / Export" },
  "install-targets": { eyebrow: "Deploy", title: "Install Targets" },
  "market-submit": { eyebrow: "Publish", title: "Submit to Market" },
  settings: { eyebrow: "Configure", title: "Settings" },
  account: { eyebrow: "Account", title: "Your AgentKitProject account" },
  about: { eyebrow: "About", title: "About AgentKitForge" }
};

export default function ForgeApp({ user, config }: { user: SessionUser; config: PublicConfig }) {
  const forge: Forge = useMemo(() => getForgeClient(), []);
  const [section, setSection] = useState<SectionId>("my-kits");
  const [kits, setKits] = useState<MyKitEntry[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [openKitId, setOpenKitId] = useState<string | null>(null);
  const [submitKitId, setSubmitKitId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [usage, setUsage] = useState<UsageInfo>(null);
  // Deep-link target for an output-only protected kit run (?kit=market:<slug>).
  const [runMarketSlug, setRunMarketSlug] = useState<string | null>(null);

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
    // Deep-link: ?kit=market:<slug> from Market's "Use in Forge (web)" → jump to
    // Run / Chat and preselect the protected kit. Honored only when Market is
    // enabled (self-host without a Market never accepts a Market deep link).
    const kitParam = new URLSearchParams(window.location.search).get("kit");
    if (kitParam && kitParam.startsWith("market:") && config.marketEnabled) {
      setRunMarketSlug(kitParam.slice("market:".length).trim() || null);
      setSection("run");
      return;
    }
    if (sectionParam && isValidSectionId(sectionParam)) {
      setSection(sectionParam);
    }
    // The pre-paint inline script (themeInitScript) and the shell's built-in
    // ThemeToggle own data-theme now, so no extra theme wiring is needed here.
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

  // Organizations are managed ONLY in AgentKitProfile; no redundant link here —
  // users reach Profile via the standard app-switcher.

  // Docs: external link to this app's docs page. Always present (docsUrl always
  // defaults, even on self-host). Kept LAST in the functional nav.
  navItems.push({
    label: "Docs",
    icon: (
      <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 4.5h9a2 2 0 012 2V20a1.5 1.5 0 00-1.5-1.5H5z" />
        <path d="M5 4.5A1.5 1.5 0 003.5 6v13A1.5 1.5 0 015 17.5" />
      </svg>
    ),
    href: `${config.links.docsUrl}/web-forge/`,
    external: true
  });

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
        brandSubtitle="Forge"
        brandAccent={BRAND_ACCENTS.forge.accent}
        brandAccentStrong={BRAND_ACCENTS.forge.strong}
        appSwitcher={buildAppSwitcher({ current: "forge", links: { market: config.links.marketUrl, auto: config.links.autoUrl, profile: config.links.profileUrl } })}
        nav={navItems}
        themeToggle
        account={
          <SidebarAccountFooter
            identity={user?.email}
            accountActive={section === "account" && !openKitId}
            onAccountClick={() => {
              setOpenKitId(null);
              setSection("account");
            }}
          />
        }
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
            <RunSection forge={forge} kits={kits} notify={notify} initialMarketSlug={runMarketSlug} />
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
