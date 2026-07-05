"use client";

import { Badge, Button } from "@agentkitforge/ui";
import type { SessionUser } from "./shared";
import { useConfig } from "../config-context";

export function AccountSection({ user }: { user: SessionUser }) {
  const { marketEnabled, links } = useConfig();
  const marketBaseUrl = links.marketUrl;
  const autoBaseUrl = links.autoUrl;
  return (
    <div className="account-screen">
      <div className="account-panel">
        <h2>Signed in</h2>
        <div className="about-meta">
          <p className="form-copy"><strong>{user?.email ?? "Unknown"}</strong></p>
          <p className="form-copy">On the web, your AgentKitProject account is the AuthKit cookie session — there is no separate device login. Market submit and licensed previews use this session.</p>
        </div>
        <div className="button-row">
          <Button variant="secondary" href="/auth/sign-out">Sign out</Button>
          {links.profileUrl && (
            <Button variant="secondary" href={links.profileUrl} target="_blank" rel="noreferrer">Manage profile</Button>
          )}
        </div>
      </div>

      {/* Market connection panel — only when Market is enabled on this instance. */}
      {marketEnabled && (
      <div className="account-panel" style={{ marginTop: 20 }}>
        <h2>Market connection</h2>
        <div className="about-meta">
          <p className="form-copy">
            <strong>Hosted AgentKitMarket</strong> — connected via your AgentKitProject session.
          </p>
          <div className="provider-card" style={{ marginTop: 8 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: "0.82em", color: "var(--color-text-secondary)", minWidth: 100 }}>Base URL</span>
                <span className="inline-code" style={{ fontSize: "0.82em" }}>{marketBaseUrl}</span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: "0.82em", color: "var(--color-text-secondary)", minWidth: 100 }}>Auth mode</span>
                <span style={{ fontSize: "0.82em" }}>AgentKitProject (WorkOS cookie session)</span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: "0.82em", color: "var(--color-text-secondary)", minWidth: 100 }}>Submit</span>
                <Badge tone="success">Available — requires sign-in</Badge>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: "0.82em", color: "var(--color-text-secondary)", minWidth: 100 }}>Import</span>
                <Badge tone="success">Available — requires sign-in</Badge>
              </div>
            </div>
          </div>

          <p className="form-copy" style={{ marginTop: 12 }}>
            <strong>Private Market</strong> — not yet available on this instance. Self-hosted Market support is part of Market Phase 2.
          </p>
          <div className="provider-card" style={{ opacity: 0.6 }}>
            <p className="form-copy" style={{ margin: 0, fontSize: "0.85em" }}>
              Private / self-hosted Market: coming in Phase 2. When available, you will be able to configure a custom base URL and credentials here.
            </p>
          </div>
        </div>
        <div className="button-row" style={{ marginTop: 12 }}>
          {marketBaseUrl && (
            <Button variant="secondary" href={marketBaseUrl} target="_blank" rel="noreferrer">Open AgentKitMarket</Button>
          )}
        </div>
      </div>
      )}

      {/* AgentKitAuto connection panel */}
      <div className="account-panel" style={{ marginTop: 20 }}>
        <h2>AgentKitAuto <Badge tone="success" style={{ marginLeft: 6 }}>Live</Badge></h2>
        <p className="form-copy">
          AgentKitAuto runs Agent Kits automatically on schedules, events, and triggers. It requires explicit opt-in and will never run background operations without your permission. Hosted at auto.agentkitproject.com, and self-hostable.
        </p>
        <div className="button-row" style={{ marginTop: 12 }}>
          {autoBaseUrl && (
            <Button variant="secondary" href={autoBaseUrl} target="_blank" rel="noreferrer">Open AgentKitAuto</Button>
          )}
        </div>
      </div>
    </div>
  );
}
