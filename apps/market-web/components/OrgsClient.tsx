"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Organization, OrgMembership, OrgInvite } from "@agentkitforge/contracts";
import { Button, Input, Select } from "@agentkitforge/ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Loadable<T> =
  | { status: "loading" }
  | { status: "loaded"; data: T }
  | { status: "failed"; message: string };

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// My invites panel
// ---------------------------------------------------------------------------

export function MyOrgInvitesList() {
  const [state, setState] = useState<Loadable<OrgInvite[]>>({ status: "loading" });
  const [accepting, setAccepting] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ status: "loading" });
    fetch("/api/orgs/invites", { headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((payload: unknown) => {
        const items = Array.isArray(payload)
          ? (payload as OrgInvite[])
          : Array.isArray((payload as Record<string, unknown>)?.items)
            ? ((payload as Record<string, unknown[]>).items as OrgInvite[])
            : Array.isArray((payload as Record<string, unknown>)?.invites)
              ? ((payload as Record<string, unknown[]>).invites as OrgInvite[])
              : [];
        setState({ status: "loaded", data: items });
      })
      .catch((err: unknown) => {
        setState({ status: "failed", message: err instanceof Error ? err.message : "Could not load invites." });
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleAccept = async (orgId: string) => {
    setAccepting(orgId);
    setAcceptError(null);
    try {
      await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/invites/accept`, {
        method: "POST",
        body: JSON.stringify({ orgId })
      });
      load();
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : "Failed to accept invite.");
    } finally {
      setAccepting(null);
    }
  };

  if (state.status === "loading") {
    return (
      <div className="empty-state">
        <strong>Loading invites</strong>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="empty-state danger-state">
        <strong>Could not load invites</strong>
        <p>{state.message}</p>
      </div>
    );
  }

  if (state.data.length === 0) {
    return (
      <div className="empty-state">
        <strong>No pending invites</strong>
        <p>You have no pending organization invites.</p>
      </div>
    );
  }

  return (
    <div className="table-panel">
      {acceptError && (
        <div className="rule-callout danger-callout">
          <strong>Accept failed</strong>
          <span>{acceptError}</span>
        </div>
      )}
      <div className="table-row table-head">
        <strong>Org</strong>
        <span>Role</span>
        <span>Invited</span>
        <span></span>
      </div>
      {state.data.map((invite) => (
        <div key={`${invite.orgId}-${invite.userId ?? invite.email ?? ""}`} className="table-row">
          <span>{invite.orgId}</span>
          <span>{invite.role}</span>
          <span>{invite.createdAt ? new Date(invite.createdAt).toLocaleDateString() : "—"}</span>
          <span>
            <Button
              variant="secondary"
              size="sm"
              disabled={accepting === invite.orgId}
              onClick={() => { void handleAccept(invite.orgId); }}
            >
              {accepting === invite.orgId ? "Accepting…" : "Accept"}
            </Button>
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create org form
// ---------------------------------------------------------------------------

export function CreateOrgForm({ onCreated }: { onCreated: () => void }) {
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/orgs", {
        method: "POST",
        body: JSON.stringify({
          displayName: displayName.trim(),
          handle: handle.trim() || undefined
        })
      });
      setDisplayName("");
      setHandle("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create organization.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="inline-form" onSubmit={(e) => { void handleSubmit(e); }}>
      <h3>Create organization</h3>
      {error && (
        <div className="rule-callout danger-callout">
          <strong>Error</strong>
          <span>{error}</span>
        </div>
      )}
      <label className="field-label">
        Display name <span className="required">*</span>
        <Input
          type="text"
          value={displayName}
          maxLength={80}
          required
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="My Team"
          disabled={submitting}
        />
      </label>
      <label className="field-label">
        Handle (optional)
        <Input
          type="text"
          value={handle}
          maxLength={32}
          pattern="[a-z0-9-]{3,32}"
          onChange={(e) => setHandle(e.target.value)}
          placeholder="my-team"
          disabled={submitting}
        />
      </label>
      <Button type="submit" disabled={submitting || !displayName.trim()}>
        {submitting ? "Creating…" : "Create organization"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Org list
// ---------------------------------------------------------------------------

export function OrgList() {
  const [state, setState] = useState<Loadable<Organization[]>>({ status: "loading" });
  const [showCreate, setShowCreate] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ status: "loading" });
    fetch("/api/orgs", { headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((payload: unknown) => {
        const items = Array.isArray(payload)
          ? (payload as Organization[])
          : Array.isArray((payload as Record<string, unknown>)?.items)
            ? ((payload as Record<string, unknown[]>).items as Organization[])
            : Array.isArray((payload as Record<string, unknown>)?.orgs)
              ? ((payload as Record<string, unknown[]>).orgs as Organization[])
              : [];
        setState({ status: "loaded", data: items });
      })
      .catch((err: unknown) => {
        setState({ status: "failed", message: err instanceof Error ? err.message : "Could not load organizations." });
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreated = () => {
    setShowCreate(false);
    load();
  };

  const handleDelete = async (org: Organization) => {
    if (!window.confirm(`Delete the organization "${org.displayName}"? This cannot be undone.`)) {
      return;
    }
    setDeleting(org.orgId);
    setDeleteError(null);
    try {
      await apiFetch(`/api/orgs/${encodeURIComponent(org.orgId)}`, { method: "DELETE" });
      load();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete organization.");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div>
      {deleteError && (
        <div className="rule-callout danger-callout" style={{ marginBottom: "1rem" }}>
          <strong>Delete failed</strong>
          <span>{deleteError}</span>
        </div>
      )}
      <div className="page-actions" style={{ marginBottom: "1rem" }}>
        <Button
          variant="secondary"
          onClick={() => setShowCreate((v) => !v)}
        >
          {showCreate ? "Cancel" : "New organization"}
        </Button>
      </div>

      {showCreate && (
        <div style={{ marginBottom: "1.5rem" }}>
          <CreateOrgForm onCreated={handleCreated} />
        </div>
      )}

      {state.status === "loading" && (
        <div className="empty-state">
          <strong>Loading organizations</strong>
        </div>
      )}

      {state.status === "failed" && (
        <div className="empty-state danger-state">
          <strong>Could not load organizations</strong>
          <p>{state.message}</p>
        </div>
      )}

      {state.status === "loaded" && state.data.length === 0 && (
        <div className="empty-state">
          <strong>No organizations yet</strong>
          <p>Create a team organization to share kits with colleagues.</p>
        </div>
      )}

      {state.status === "loaded" && state.data.length > 0 && (
        <div className="table-panel">
          <div className="table-row table-head">
            <strong>Name</strong>
            <span>Type</span>
            <span>Slug</span>
            <span>Created</span>
            <span></span>
          </div>
          {state.data.map((org) => (
            <div key={org.orgId} className="table-row">
              <strong>{org.displayName}</strong>
              <span>{org.type}</span>
              <span>{org.slug}</span>
              <span>{org.createdAt ? new Date(org.createdAt).toLocaleDateString() : "—"}</span>
              <span style={{ display: "inline-flex", gap: "0.75rem", alignItems: "center" }}>
                <Link className="secondary-link" href={`/orgs/${encodeURIComponent(org.orgId)}`}>
                  Manage
                </Link>
                {org.type === "team" && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={deleting === org.orgId}
                    onClick={() => { void handleDelete(org); }}
                  >
                    {deleting === org.orgId ? "Deleting…" : "Delete"}
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Org detail — members management
// ---------------------------------------------------------------------------

export function OrgMembersPanel({ orgId }: { orgId: string }) {
  const [state, setState] = useState<Loadable<OrgMembership[]>>({ status: "loading" });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"owner" | "admin" | "member" | "viewer">("member");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ status: "loading" });
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/members`, { headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((payload: unknown) => {
        const items = Array.isArray(payload)
          ? (payload as OrgMembership[])
          : Array.isArray((payload as Record<string, unknown>)?.items)
            ? ((payload as Record<string, unknown[]>).items as OrgMembership[])
            : Array.isArray((payload as Record<string, unknown>)?.members)
              ? ((payload as Record<string, unknown[]>).members as OrgMembership[])
              : [];
        setState({ status: "loaded", data: items });
      })
      .catch((err: unknown) => {
        setState({ status: "failed", message: err instanceof Error ? err.message : "Could not load members." });
      });
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setAdding(true);
    setFormError(null);
    try {
      await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/members`, {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role })
      });
      setEmail("");
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to add member.");
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (memberId: string) => {
    setRemoving(memberId);
    try {
      await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}`, {
        method: "DELETE"
      });
      load();
    } catch (err) {
      console.error("Remove member failed", err);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div>
      <h2>Members</h2>

      <form className="inline-form" style={{ marginBottom: "1.5rem" }} onSubmit={(e) => { void handleAdd(e); }}>
        <h3>Add member</h3>
        {formError && (
          <div className="rule-callout danger-callout">
            <strong>Error</strong>
            <span>{formError}</span>
          </div>
        )}
        <label className="field-label">
          Email address <span className="required">*</span>
          <Input
            type="email"
            value={email}
            required
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
            disabled={adding}
          />
        </label>
        <label className="field-label">
          Role
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
            disabled={adding}
          >
            <option value="owner">Owner</option>
            <option value="admin">Admin</option>
            <option value="member">Member</option>
            <option value="viewer">Viewer</option>
          </Select>
        </label>
        <Button type="submit" disabled={adding || !email.trim()}>
          {adding ? "Adding…" : "Add member"}
        </Button>
      </form>

      {state.status === "loading" && (
        <div className="empty-state">
          <strong>Loading members</strong>
        </div>
      )}
      {state.status === "failed" && (
        <div className="empty-state danger-state">
          <strong>Could not load members</strong>
          <p>{state.message}</p>
        </div>
      )}
      {state.status === "loaded" && state.data.length === 0 && (
        <div className="empty-state">
          <strong>No members yet</strong>
          <p>Add members by their email address.</p>
        </div>
      )}
      {state.status === "loaded" && state.data.length > 0 && (
        <div className="table-panel">
          <div className="table-row table-head">
            <strong>User ID</strong>
            <span>Role</span>
            <span>Status</span>
            <span>Since</span>
            <span></span>
          </div>
          {state.data.map((m) => (
            <div key={m.userId} className="table-row">
              <span>{m.userId}</span>
              <span>{m.role}</span>
              <span>{m.status}</span>
              <span>{m.createdAt ? new Date(m.createdAt).toLocaleDateString() : "—"}</span>
              <span>
                <Button
                  variant="danger"
                  disabled={removing === m.userId}
                  onClick={() => { void handleRemove(m.userId); }}
                >
                  {removing === m.userId ? "Removing…" : "Remove"}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kit controls — transfer + visibility
// ---------------------------------------------------------------------------

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
            <p>You have no organizations to transfer this kit to. <Link href="/orgs">Create one first.</Link></p>
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

// The Stripe Connect seller payouts panel (OrgPayoutsPanel) moved to the
// optional @agentkit-commercial/market-web package; the org detail page mounts
// it via next/dynamic only when NEXT_PUBLIC_COMMERCE_ENABLED is set.
