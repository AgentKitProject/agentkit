"use client";

import { useEffect, useState } from "react";
import { SidebarAccountFooter } from "@agentkitforge/ui";

type SessionResponse = {
  authenticated: boolean;
  role?: "user" | "admin" | "owner";
  email?: string;
};

/**
 * Sidebar account block for the Profile AppShell. Resolves the session
 * client-side (same `/api/auth/session` endpoint HeaderAuthNav used) and renders
 * the shared SidebarAccount + a Sign out nav-item when signed in, or a Sign in
 * button otherwise — mirroring the market sidebar's vertical account slot.
 */
export function SidebarAuth() {
  const [session, setSession] = useState<SessionResponse | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/auth/session", {
          cache: "no-store",
          credentials: "include",
        });
        if (!active || !res.ok) return;
        setSession(await res.json());
      } catch {
        if (active) setSession({ authenticated: false });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (session === null) {
    return <div className="h-10 w-full animate-pulse rounded-md bg-[var(--ak-surface-2,rgba(148,163,184,0.18))]" />;
  }

  if (session.authenticated !== true) {
    return (
      <a className="ak-btn ak-btn--secondary ak-btn--sm" href="/auth/sign-in">
        Sign in / Create account
      </a>
    );
  }

  return <SidebarAccountFooter identity={session.email} accountHref="/account" />;
}
