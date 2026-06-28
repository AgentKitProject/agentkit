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
import { useCallback, useEffect, useState } from "react";
import { AppShell, SidebarAccount, BRAND_ACCENTS } from "@agentkitforge/ui";
import type { MyKitEntry } from "@/forge-client";
import { AutoSection } from "./sections/AutoSection";

const AUTO_GREEN = BRAND_ACCENTS.auto.accent;
const AUTO_GREEN_STRONG = BRAND_ACCENTS.auto.strong;

type Toast = { msg: string; err: boolean } | null;

export function AutoApp({
  user,
  marketUrl,
  marketEnabled
}: {
  user: { id: string; email: string };
  marketUrl?: string;
  marketEnabled?: boolean;
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
      <AutoSection kits={kits} notify={notify} marketUrl={marketUrl} marketEnabled={marketEnabled} />
    </AppShell>
  );
}
