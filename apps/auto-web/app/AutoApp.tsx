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
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell, SidebarAccount } from "@agentkitforge/ui";
import type { MyKitEntry } from "@/forge-client";
import { AutoLogo } from "./sections/AutoLogo";
import { AutoSection } from "./sections/AutoSection";

const AUTO_GREEN = "#16a34a";
const AUTO_GREEN_STRONG = "#15803d";

type Toast = { msg: string; err: boolean } | null;

// Persisted theme: reads/writes localStorage "akf-theme" (the same key the
// pre-paint inline script in app/layout.tsx reads). Mirrors forge-web's hook.
function useTheme(): [string, () => void] {
  // Default to "light" on BOTH server and first client render so the SSR HTML
  // matches the client's initial render (no hydration mismatch). The real
  // persisted/system theme is read AFTER mount; the inline layout script has
  // already set data-theme pre-paint, so there is no flash.
  const [theme, setTheme] = useState<string>("light");

  useEffect(() => {
    const saved =
      localStorage.getItem("akf-theme") ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(saved);
  }, []);

  // Skip the first render (the "light" placeholder) to avoid a one-frame flash,
  // then apply + persist on every change.
  const synced = useRef(false);
  useEffect(() => {
    if (!synced.current) {
      synced.current = true;
      return;
    }
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("akf-theme", theme);
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}

// Minimal inline theme icons to avoid adding a dep (mirrors forge-web).
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

export function AutoApp({ user }: { user: { id: string; email: string } }) {
  const [kits, setKits] = useState<MyKitEntry[]>([]);
  const [toast, setToast] = useState<Toast>(null);
  const [theme, toggleTheme] = useTheme();

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

  return (
    <AppShell
      logo={<img src="/agentkitauto-logo.png" alt="AgentKitAuto" height={32} style={{ display: "block" }} />}
      brandSubtitle="Autonomous runs"
      brandAccent={AUTO_GREEN}
      brandAccentStrong={AUTO_GREEN_STRONG}
      eyebrow="AgentKitAuto"
      title="Autonomous runs"
      account={
        <SidebarAccount name={user.email || "Account"} status="Signed in" initials={initials} href="/auth/sign-out" />
      }
      sidebarFooter={
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
      }
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
      <AutoSection kits={kits} notify={notify} />
    </AppShell>
  );
}
