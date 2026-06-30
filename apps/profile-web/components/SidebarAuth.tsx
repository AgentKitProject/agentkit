"use client";

import { useEffect, useState } from "react";
import { SidebarAccount } from "@agentkitforge/ui";

type SessionResponse = {
  authenticated: boolean;
  role?: "user" | "admin" | "owner";
};

// Door / arrow — matches the sign-out glyph used in the market sidebar.
const signOutIcon = (
  <svg
    viewBox="0 0 24 24"
    width={18}
    height={18}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 12H6m0 0l3-3m-3 3l3 3" />
    <path d="M11 4.5h6a1 1 0 011 1v13a1 1 0 01-1 1h-6" />
  </svg>
);

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

  return (
    <>
      <SidebarAccount name="Account" status="Signed in" initials="AK" href="/account" />
      <a className="ak-nav-item" href="/auth/sign-out">
        <span className="ak-nav-item__icon" aria-hidden="true">
          {signOutIcon}
        </span>
        <span className="ak-nav-item__label">Sign out</span>
      </a>
    </>
  );
}
