"use client";

// AgentKitAuto standalone shell.
//
// This is the whole app: a single-surface Auto dashboard. It owns the two
// dependencies AutoSection used to receive from the Forge shell:
//   • `kits`   — the user's kit library, fetched from GET /api/kits (the same
//                KitStore-backed route as Web Forge). Auto only reads kitId +
//                name to populate the approval/run/schedule/webhook selectors.
//   • `notify` — a lightweight toast.
//
// Wrapped in the framework AppShell with the Auto brand (AutoLogo + green
// accent). Auth is enforced server-side in page.tsx (requireUser); this client
// component assumes an authenticated session and talks to /api/* with cookies.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AppShell, SidebarAccount, BRAND_ACCENTS, type SidebarNavItem } from "@agentkitforge/ui";
import type { MyKitEntry } from "@/forge-client";
import { AutoSection } from "./sections/AutoSection";
import { AUTO_SECTIONS, DEFAULT_AUTO_SECTION, isAutoSectionId, type AutoSectionId } from "./sections/section-ids";

// Minimal 18px stroke icons for the sidebar nav (no icon dependency). One per
// section id, keyed below.
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const SECTION_ICONS: Record<AutoSectionId, ReactNode> = {
  run: (<svg viewBox="0 0 24 24" width={18} height={18} {...stroke}><path d="M6 4l13 8-13 8z" /></svg>),
  runs: (<svg viewBox="0 0 24 24" width={18} height={18} {...stroke}><path d="M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>),
  approvals: (<svg viewBox="0 0 24 24" width={18} height={18} {...stroke}><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></svg>),
  schedules: (<svg viewBox="0 0 24 24" width={18} height={18} {...stroke}><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></svg>),
  webhooks: (<svg viewBox="0 0 24 24" width={18} height={18} {...stroke}><path d="M13 3L4 14h7l-1 7 9-11h-7z" /></svg>),
  settings: (<svg viewBox="0 0 24 24" width={18} height={18} {...stroke}><circle cx="12" cy="12" r="3.2" /><path d="M19.4 13.5a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-2.9-1.2l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00-1.2-2.9H3a2 2 0 110-4h.1a1.7 1.7 0 001.2-2.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3 1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9 1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>),
};

// Building/org icon for the external "Organization" link (settings live in Profile).
const ORG_ICON: ReactNode = (
  <svg viewBox="0 0 24 24" width={18} height={18} {...stroke}>
    <path d="M3 21h18M5 21V5a1 1 0 011-1h7a1 1 0 011 1v16M14 21V9h4a1 1 0 011 1v11" />
    <path d="M8 7h2M8 11h2M8 15h2" />
  </svg>
);

const AUTO_GREEN = BRAND_ACCENTS.auto.accent;
const AUTO_GREEN_STRONG = BRAND_ACCENTS.auto.strong;

type Toast = { msg: string; err: boolean } | null;

export function AutoApp({
  user,
  marketUrl,
  profileUrl,
  marketEnabled,
  allowedProviders
}: {
  user: { id: string; email: string };
  marketUrl?: string;
  profileUrl?: string;
  marketEnabled?: boolean;
  /** Provider-lock: the AI provider types this deployment permits, or null when
   *  unrestricted. The settings UI hides disallowed BYO options. */
  allowedProviders?: string[] | null;
}) {
  const [kits, setKits] = useState<MyKitEntry[]>([]);
  const [toast, setToast] = useState<Toast>(null);

  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast(null), 4200);
  }, []);

  // Load the kit library for the selectors. A failure here is non-fatal: Auto
  // still renders (empty selectors) so the rest of the surface is usable.
  const refreshKits = useCallback(async () => {
    try {
      const res = await fetch("/api/kits", { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load kits (HTTP ${res.status}).`);
      const body = (await res.json()) as { kits?: MyKitEntry[] };
      setKits(Array.isArray(body.kits) ? body.kits : []);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  }, [notify]);

  useEffect(() => {
    void refreshKits();
  }, [refreshKits]);

  const initials = (user.email || "?").slice(0, 2).toUpperCase();

  // Active dashboard tab. Each maps to one full-width pane in AutoSection.
  const [section, setSection] = useState<AutoSectionId>(DEFAULT_AUTO_SECTION);
  // Deep-link the active tab from ?section= (falls back to the default). The
  // separate ?kit= "Run on Auto" deep link still lands on the default "run" tab.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("section");
    if (p && isAutoSectionId(p)) setSection(p);
  }, []);

  const navItems: SidebarNavItem[] = AUTO_SECTIONS.map((s) => ({
    label: s.label,
    icon: SECTION_ICONS[s.id],
    active: section === s.id,
    onClick: () => setSection(s.id)
  }));
  // Discoverability link out to AgentKitProfile, where org settings now live
  // (Profile is the system of record for org management). Only when a Profile
  // URL is configured (omitted on a Profile-less self-host).
  if (profileUrl) {
    navItems.push({
      label: "Organization",
      icon: ORG_ICON,
      href: `${profileUrl}/account/orgs`,
      external: true
    });
  }
  const activeTitle = AUTO_SECTIONS.find((s) => s.id === section)?.title ?? "Autonomous runs";

  return (
    <AppShell
      logo={
        <img
          src="/agentkitauto-icon.png"
          alt="AgentKitAuto"
          style={{ display: "block", width: "auto", height: 32, maxWidth: "100%", objectFit: "contain" }}
        />
      }
      brand={
        <>
          AgentKit<span style={{ color: "var(--ak-brand)" }}>Auto</span>
        </>
      }
      brandAccent={AUTO_GREEN}
      brandAccentStrong={AUTO_GREEN_STRONG}
      eyebrow="AgentKitAuto"
      title={activeTitle}
      nav={navItems}
      account={
        <SidebarAccount name={user.email || "Account"} status="Signed in" initials={initials} href="/auth/sign-out" />
      }
      themeToggle
    >
      {toast && (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 20,
            right: 20,
            zIndex: 50,
            padding: "10px 16px",
            borderRadius: 8,
            color: "#fff",
            background: toast.err ? "var(--color-error, #dc2626)" : AUTO_GREEN_STRONG,
            boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
            maxWidth: 360
          }}
        >
          {toast.msg}
        </div>
      )}
      <AutoSection
        section={section}
        kits={kits}
        notify={notify}
        marketUrl={marketUrl}
        marketEnabled={marketEnabled}
        allowedProviders={allowedProviders}
      />
    </AppShell>
  );
}
