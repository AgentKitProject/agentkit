"use client";

import { useState } from "react";
import type { Organization } from "@agentkitforge/contracts";
import { Button, Select } from "@agentkitforge/ui";

// ---------------------------------------------------------------------------
// Kit organization controls — transfer ownership + catalog visibility. These are
// KIT-table mutations owned by market-core (NOT Profile org entities), so they
// stay in market-web and proxy to the market backend via the `/api/kits/*`
// routes. Extracted from the former OrgsClient when org MANAGEMENT moved to
// AgentKitProfile (P3); only the kit controls remain here.
// ---------------------------------------------------------------------------

async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...init
  });
  const payload = (await res.json()) as unknown;
  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload && typeof (payload as Record<string, unknown>).message === "string"
        ? (payload as { message: string }).message
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return payload;
}

export function KitOrgControls({ kitId, myOrgs }: { kitId: string; myOrgs: Organization[] }) {
  const [targetOrgId, setTargetOrgId] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [transferring, setTransferring] = useState(false);
  const [settingVis, setSettingVis] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [visError, setVisError] = useState<string | null>(null);
  const [transferOk, setTransferOk] = useState(false);
  const [visOk, setVisOk] = useState(false);

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetOrgId) return;
    setTransferring(true);
    setTransferError(null);
    setTransferOk(false);
    try {
      await apiFetch(`/api/kits/${encodeURIComponent(kitId)}/transfer`, {
        method: "POST",
        body: JSON.stringify({ kitId, targetOrgId })
      });
      setTransferOk(true);
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : "Transfer failed.");
    } finally {
      setTransferring(false);
    }
  };

  const handleSetVisibility = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingVis(true);
    setVisError(null);
    setVisOk(false);
    try {
      await apiFetch(`/api/kits/${encodeURIComponent(kitId)}/visibility`, {
        method: "POST",
        body: JSON.stringify({ kitId, visibility })
      });
      setVisOk(true);
    } catch (err) {
      setVisError(err instanceof Error ? err.message : "Could not update visibility.");
    } finally {
      setSettingVis(false);
    }
  };

  return (
    <div>
      <h2>Kit organization settings</h2>

      <section style={{ marginBottom: "2rem" }}>
        <h3>Transfer ownership</h3>
        <p>Transfer this kit to one of your organizations.</p>
        {transferOk && (
          <div className="rule-callout">
            <strong>Transfer submitted</strong>
            <span>The kit ownership transfer is being processed.</span>
          </div>
        )}
        {transferError && (
          <div className="rule-callout danger-callout">
            <strong>Transfer failed</strong>
            <span>{transferError}</span>
          </div>
        )}
        {myOrgs.length === 0 ? (
          <div className="empty-state">
            <p>You have no organizations to transfer this kit to. Create one in your AgentKitProject account first.</p>
          </div>
        ) : (
          <form className="inline-form" onSubmit={(e) => { void handleTransfer(e); }}>
            <label className="field-label">
              Target organization
              <Select
                value={targetOrgId}
                onChange={(e) => setTargetOrgId(e.target.value)}
                disabled={transferring}
              >
                <option value="">Select organization…</option>
                {myOrgs.map((org) => (
                  <option key={org.orgId} value={org.orgId}>
                    {org.displayName}
                  </option>
                ))}
              </Select>
            </label>
            <Button type="submit" disabled={transferring || !targetOrgId}>
              {transferring ? "Transferring…" : "Transfer kit"}
            </Button>
          </form>
        )}
      </section>

      <section>
        <h3>Kit visibility</h3>
        <p>Control whether this kit appears in the public catalog.</p>
        {visOk && (
          <div className="rule-callout">
            <strong>Visibility updated</strong>
          </div>
        )}
        {visError && (
          <div className="rule-callout danger-callout">
            <strong>Update failed</strong>
            <span>{visError}</span>
          </div>
        )}
        <form className="inline-form" onSubmit={(e) => { void handleSetVisibility(e); }}>
          <label className="field-label">
            Visibility
            <Select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as "public" | "private")}
              disabled={settingVis}
            >
              <option value="public">Public — listed in the catalog</option>
              <option value="private">Private — org members only</option>
            </Select>
          </label>
          <Button type="submit" disabled={settingVis}>
            {settingVis ? "Saving…" : "Set visibility"}
          </Button>
        </form>
      </section>
    </div>
  );
}
