"use client";

import { Badge, Button } from "@agentkitforge/ui";
import { useEffect, useState } from "react";

type SessionResponse = {
  authenticated: boolean;
  role?: "user" | "admin" | "owner";
};

export function HeaderAuthNav() {
  const [session, setSession] = useState<SessionResponse | null>(null);

  useEffect(() => {
    let active = true;

    async function loadSession() {
      try {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
          credentials: "include",
        });

        if (!active || !response.ok) {
          return;
        }

        setSession(await response.json());
      } catch {
        if (active) {
          setSession({ authenticated: false });
        }
      }
    }

    loadSession();

    return () => {
      active = false;
    };
  }, []);

  const authenticated = session?.authenticated === true;

  if (session === null) {
    return (
      <div className="flex items-center gap-2">
        <div className="h-9 w-16 animate-pulse rounded-md bg-slate-100" />
        <div className="h-9 w-20 animate-pulse rounded-md bg-slate-100" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" href="/account">
        Account
      </Button>
      {authenticated ? (
        <>
          <Button variant="ghost" size="sm" href="/account/products">
            Products
          </Button>
          {session.role && session.role !== "user" ? (
            <Badge tone="warning">{session.role}</Badge>
          ) : null}
          <Button size="sm" href="/auth/sign-out">
            Sign out
          </Button>
        </>
      ) : (
        <Button size="sm" href="/auth/sign-in">
          Sign in
        </Button>
      )}
    </div>
  );
}
