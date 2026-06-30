"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type {
  Organization,
  OrgMembership,
  OrgInvite,
  OrgKeyProviderType,
  OrgApiKeyStatus,
  OrgApiKeyProviderStatus,
  OrgRunBudgetStatus,
} from "@agentkitforge/contracts";
import { orgApiKeyStatusSchema, orgRunBudgetStatusSchema } from "@agentkitforge/contracts";
import { Button, Input, Select } from "@agentkitforge/ui";

// ---------------------------------------------------------------------------
// Org-management UI (ported from market-web → AgentKitProfile in P3). All data
// flows through profile-web's own cookie-authed `/api/orgs/*` routes, which call
// Profile's in-process org handlers (Profile is the system of record for orgs).
// Styling follows the account UI's Tailwind utilities (see AccountProfileSummary).
// ---------------------------------------------------------------------------

type Loadable<T> =
  | { status: "loading" }
  | { status: "loaded"; data: T }
  | { status: "failed"; message: string };

// Shared style fragments matching the account UI.
const PANEL = "rounded-md border border-slate-200 bg-white p-4";
const NOTICE = "rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800";
const DANGER = "rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700";
const MUTED = "text-sm text-[var(--muted)]";
const LABEL = "grid gap-1 text-sm font-medium text-slate-700";

async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...init,
  });
  const payload = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload && typeof (payload as Record<string, unknown>).message === "string"
        ? (payload as { message: string }).message
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return payload;
}

function asArray<T>(payload: unknown, ...keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    for (const key of keys) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
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
    fetch("/api/orgs/invites", { credentials: "include", headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((payload: unknown) => {
        setState({ status: "loaded", data: asArray<OrgInvite>(payload, "items", "invites") });
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
      await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/invites/accept`, { method: "POST", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : "Failed to accept invite.");
    } finally {
      setAccepting(null);
    }
  };

  if (state.status === "loading") {
    return <p className={MUTED}>Loading invites…</p>;
  }
  if (state.status === "failed") {
    return <div className={DANGER}>{state.message}</div>;
  }
  if (state.data.length === 0) {
    return (
      <div className={PANEL}>
        <strong className="text-slate-950">No pending invites</strong>
        <p className={`mt-1 ${MUTED}`}>You have no pending organization invites.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {acceptError && <div className={DANGER}>{acceptError}</div>}
      <div className={`${PANEL} grid gap-3`}>
        {state.data.map((invite) => (
          <div key={`${invite.orgId}-${invite.userId ?? invite.email ?? ""}`} className="flex items-center justify-between gap-4">
            <div>
              <div className="font-medium text-slate-950">{invite.orgId}</div>
              <div className={MUTED}>
                {invite.role}
                {invite.createdAt ? ` · invited ${new Date(invite.createdAt).toLocaleDateString()}` : ""}
              </div>
            </div>
            <Button variant="secondary" size="sm" disabled={accepting === invite.orgId} onClick={() => { void handleAccept(invite.orgId); }}>
              {accepting === invite.orgId ? "Accepting…" : "Accept"}
            </Button>
          </div>
        ))}
      </div>
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
        body: JSON.stringify({ displayName: displayName.trim(), handle: handle.trim() || undefined }),
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
    <form className={`${PANEL} grid gap-4`} onSubmit={(e) => { void handleSubmit(e); }}>
      <h3 className="text-lg font-semibold text-slate-950">Create organization</h3>
      {error && <div className={DANGER}>{error}</div>}
      <label className={LABEL}>
        Display name *
        <Input type="text" value={displayName} maxLength={80} required onChange={(e) => setDisplayName(e.target.value)} placeholder="My Team" disabled={submitting} />
      </label>
      <label className={LABEL}>
        Handle (optional)
        <Input type="text" value={handle} maxLength={32} pattern="[a-z0-9-]{3,32}" onChange={(e) => setHandle(e.target.value)} placeholder="my-team" disabled={submitting} />
      </label>
      <div>
        <Button type="submit" disabled={submitting || !displayName.trim()}>
          {submitting ? "Creating…" : "Create organization"}
        </Button>
      </div>
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
    fetch("/api/orgs", { credentials: "include", headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((payload: unknown) => {
        setState({ status: "loaded", data: asArray<Organization>(payload, "items", "orgs") });
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
    if (!window.confirm(`Delete the organization "${org.displayName}"? This cannot be undone.`)) return;
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
    <div className="grid gap-4">
      {deleteError && <div className={DANGER}>{deleteError}</div>}
      <div>
        <Button variant="secondary" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? "Cancel" : "New organization"}
        </Button>
      </div>

      {showCreate && <CreateOrgForm onCreated={handleCreated} />}

      {state.status === "loading" && <p className={MUTED}>Loading organizations…</p>}
      {state.status === "failed" && <div className={DANGER}>{state.message}</div>}
      {state.status === "loaded" && state.data.length === 0 && (
        <div className={PANEL}>
          <strong className="text-slate-950">No organizations yet</strong>
          <p className={`mt-1 ${MUTED}`}>Create a team organization to share kits with colleagues.</p>
        </div>
      )}
      {state.status === "loaded" && state.data.length > 0 && (
        <div className={`${PANEL} grid gap-3`}>
          {state.data.map((org) => (
            <div key={org.orgId} className="flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-slate-950">{org.displayName}</div>
                <div className={MUTED}>
                  {org.type} · {org.slug}
                  {org.createdAt ? ` · ${new Date(org.createdAt).toLocaleDateString()}` : ""}
                </div>
              </div>
              <span className="inline-flex items-center gap-3">
                <Link className="text-sm font-semibold text-[var(--brand)] hover:text-[var(--brand-strong)]" href={`/account/orgs/${encodeURIComponent(org.orgId)}`}>
                  Manage
                </Link>
                {org.type === "team" && (
                  <Button variant="secondary" size="sm" disabled={deleting === org.orgId} onClick={() => { void handleDelete(org); }}>
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
  const [formNotice, setFormNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ status: "loading" });
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/members`, { credentials: "include", headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((payload: unknown) => {
        setState({ status: "loaded", data: asArray<OrgMembership>(payload, "items", "members") });
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
    setFormNotice(null);
    const invitedEmail = email.trim();
    try {
      const result = await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/members`, {
        method: "POST",
        body: JSON.stringify({ email: invitedEmail, role }),
      });
      setEmail("");
      if (result && typeof result === "object" && (result as Record<string, unknown>).pending === true) {
        setFormNotice(`Invited ${invitedEmail} — they'll join when they sign up for AgentKitProject.`);
      }
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
      await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}`, { method: "DELETE" });
      load();
    } catch (err) {
      console.error("Remove member failed", err);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="grid gap-4">
      <h2 className="text-xl font-semibold text-slate-950">Members</h2>

      <form className={`${PANEL} grid gap-4`} onSubmit={(e) => { void handleAdd(e); }}>
        <h3 className="text-lg font-semibold text-slate-950">Add member</h3>
        {formError && <div className={DANGER}>{formError}</div>}
        {formNotice && <div className={NOTICE}>{formNotice}</div>}
        <label className={LABEL}>
          Email address *
          <Input type="email" value={email} required onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" disabled={adding} />
        </label>
        <label className={LABEL}>
          Role
          <Select value={role} onChange={(e) => setRole(e.target.value as typeof role)} disabled={adding}>
            <option value="owner">Owner</option>
            <option value="admin">Admin</option>
            <option value="member">Member</option>
            <option value="viewer">Viewer</option>
          </Select>
        </label>
        <div>
          <Button type="submit" disabled={adding || !email.trim()}>
            {adding ? "Adding…" : "Add member"}
          </Button>
        </div>
      </form>

      {state.status === "loading" && <p className={MUTED}>Loading members…</p>}
      {state.status === "failed" && <div className={DANGER}>{state.message}</div>}
      {state.status === "loaded" && state.data.length === 0 && (
        <div className={PANEL}>
          <strong className="text-slate-950">No members yet</strong>
          <p className={`mt-1 ${MUTED}`}>Add members by their email address.</p>
        </div>
      )}
      {state.status === "loaded" && state.data.length > 0 && (
        <div className={`${PANEL} grid gap-3`}>
          {state.data.map((m) => (
            <div key={m.userId} className="flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-slate-950">{m.userId}</div>
                <div className={MUTED}>
                  {m.role} · {m.status}
                  {m.createdAt ? ` · since ${new Date(m.createdAt).toLocaleDateString()}` : ""}
                </div>
              </div>
              <Button variant="danger" size="sm" disabled={removing === m.userId} onClick={() => { void handleRemove(m.userId); }}>
                {removing === m.userId ? "Removing…" : "Remove"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Org shared API key — owner/admin only
// ---------------------------------------------------------------------------

const ORG_KEY_PROVIDERS: { value: OrgKeyProviderType; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "gemini", label: "Gemini" },
  { value: "ollama", label: "Ollama" },
];

function providerLabel(value: string): string {
  return ORG_KEY_PROVIDERS.find((p) => p.value === value)?.label ?? value;
}

const BASE_URL_PROVIDERS = new Set<OrgKeyProviderType>(["openai-compatible", "ollama"]);

/** Determine the viewer's org role from the membership list (owner/admin → can manage). */
function useCanManage(orgId: string, viewerUserId: string): boolean | null {
  const [canManage, setCanManage] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/members`, { credentials: "include", headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((payload: unknown) => {
        if (!active) return;
        const items = asArray<OrgMembership>(payload, "items", "members");
        const mine = items.find((m) => m.userId === viewerUserId);
        setCanManage(mine?.role === "owner" || mine?.role === "admin");
      })
      .catch(() => {
        if (active) setCanManage(false);
      });
    return () => {
      active = false;
    };
  }, [orgId, viewerUserId]);
  return canManage;
}

/**
 * Owner/admin surface for the org's PER-PROVIDER shared LLM API keys. Hidden for
 * members/viewers (UI-only gate; the handler independently enforces owner/admin).
 */
export function OrgApiKeyPanel({ orgId, viewerUserId }: { orgId: string; viewerUserId: string }) {
  const canManage = useCanManage(orgId, viewerUserId);
  const [status, setStatus] = useState<Loadable<OrgApiKeyStatus>>({ status: "loading" });
  const [providerType, setProviderType] = useState<OrgKeyProviderType>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);

  const loadStatus = useCallback(() => {
    setStatus({ status: "loading" });
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/api-key`, { credentials: "include", headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((payload: unknown) => {
        const parsed = orgApiKeyStatusSchema.safeParse(payload);
        const data: OrgApiKeyStatus = parsed.success ? parsed.data : { providers: [] };
        setStatus({ status: "loaded", data });
      })
      .catch((err: unknown) => {
        setStatus({ status: "failed", message: err instanceof Error ? err.message : "Could not load the org API key status." });
      });
  }, [orgId]);

  useEffect(() => {
    if (canManage) loadStatus();
  }, [canManage, loadStatus]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setSaving(true);
    setFormError(null);
    setFormNotice(null);
    try {
      const body: Record<string, string> = { providerType, apiKey: apiKey.trim() };
      if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
      await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/api-key`, { method: "PUT", body: JSON.stringify(body) });
      setApiKey("");
      setBaseUrl("");
      setFormNotice(`${providerLabel(providerType)} key saved.`);
      loadStatus();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save the API key.");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async (provider: OrgKeyProviderType) => {
    setClearing(provider);
    setFormError(null);
    setFormNotice(null);
    try {
      await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/api-key?providerType=${encodeURIComponent(provider)}`, { method: "DELETE" });
      setFormNotice(`${providerLabel(provider)} key cleared.`);
      loadStatus();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to clear the API key.");
    } finally {
      setClearing(null);
    }
  };

  if (canManage !== true) {
    return null;
  }

  const providers: OrgApiKeyProviderStatus[] = status.status === "loaded" ? status.data.providers : [];

  return (
    <div className="grid gap-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-950">Organization API keys</h2>
        <p className={`mt-1 ${MUTED}`}>
          Members&apos; own keys take precedence; these org keys are the shared fallback per provider. Used by Auto and Web Forge.
        </p>
      </div>

      {status.status === "loading" && <p className={MUTED}>Loading API key status…</p>}
      {status.status === "failed" && <div className={DANGER}>{status.message}</div>}
      {status.status === "loaded" && (
        providers.length === 0 ? (
          <div className={PANEL}>
            <strong className="text-slate-950">No org keys configured</strong>
            <p className={`mt-1 ${MUTED}`}>Add a key below to set a shared fallback for a provider.</p>
          </div>
        ) : (
          <div className={`${PANEL} grid gap-3`}>
            {providers.map((p) => (
              <div className="flex items-center justify-between gap-4" key={p.providerType}>
                <div>
                  <div className="font-medium text-slate-950">{providerLabel(p.providerType)}</div>
                  <div className={MUTED}>
                    {p.maskedKey}
                    {p.baseUrl ? ` · ${p.baseUrl}` : ""}
                    {p.updatedAt ? ` · ${new Date(p.updatedAt).toLocaleDateString()}` : ""}
                  </div>
                </div>
                <Button variant="danger" size="sm" disabled={clearing === p.providerType} onClick={() => { void handleClear(p.providerType); }}>
                  {clearing === p.providerType ? "Clearing…" : "Clear"}
                </Button>
              </div>
            ))}
          </div>
        )
      )}

      <form className={`${PANEL} grid gap-4`} onSubmit={(e) => { void handleSave(e); }}>
        <h3 className="text-lg font-semibold text-slate-950">Add or update a key</h3>
        {formError && <div className={DANGER}>{formError}</div>}
        {formNotice && <div className={NOTICE}>{formNotice}</div>}
        <label className={LABEL}>
          Provider *
          <Select value={providerType} onChange={(e) => setProviderType(e.target.value as OrgKeyProviderType)} disabled={saving}>
            {ORG_KEY_PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </Select>
        </label>
        <label className={LABEL}>
          API key *
          <Input type="password" value={apiKey} required autoComplete="off" onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-…" disabled={saving} />
        </label>
        <label className={LABEL}>
          Base URL{BASE_URL_PROVIDERS.has(providerType) ? "" : " (optional)"}
          <Input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.anthropic.com" disabled={saving} />
        </label>
        <div>
          <Button type="submit" disabled={saving || !apiKey.trim()}>
            {saving ? "Saving…" : "Save key"}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Org default run budget — owner/admin only
// ---------------------------------------------------------------------------

/**
 * Owner/admin surface for the org's DEFAULT per-run budget (Auto). When set it
 * OVERRIDES each member's own default budget. Hidden for members/viewers.
 */
export function OrgRunBudgetPanel({ orgId, viewerUserId }: { orgId: string; viewerUserId: string }) {
  const canManage = useCanManage(orgId, viewerUserId);
  const [status, setStatus] = useState<Loadable<OrgRunBudgetStatus>>({ status: "loading" });
  const [budgetUsd, setBudgetUsd] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearingBudget, setClearingBudget] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);

  const loadStatus = useCallback(() => {
    setStatus({ status: "loading" });
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/run-budget`, { credentials: "include", headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((payload: unknown) => {
        const parsed = orgRunBudgetStatusSchema.safeParse(payload);
        const data: OrgRunBudgetStatus = parsed.success ? parsed.data : { budgetCents: null };
        setStatus({ status: "loaded", data });
        setBudgetUsd(data.budgetCents !== null ? (data.budgetCents / 100).toFixed(2) : "");
      })
      .catch((err: unknown) => {
        setStatus({ status: "failed", message: err instanceof Error ? err.message : "Could not load the run budget." });
      });
  }, [orgId]);

  useEffect(() => {
    if (canManage) loadStatus();
  }, [canManage, loadStatus]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const cents = Math.round(parseFloat(budgetUsd) * 100);
    if (!Number.isInteger(cents) || cents <= 0) {
      setFormError("Enter a positive budget amount.");
      return;
    }
    setSaving(true);
    setFormError(null);
    setFormNotice(null);
    try {
      await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/run-budget`, { method: "PUT", body: JSON.stringify({ budgetCents: cents }) });
      setFormNotice("Org default run budget saved.");
      loadStatus();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save the run budget.");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearingBudget(true);
    setFormError(null);
    setFormNotice(null);
    try {
      await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/run-budget`, { method: "DELETE" });
      setBudgetUsd("");
      setFormNotice("Org default run budget cleared.");
      loadStatus();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to clear the run budget.");
    } finally {
      setClearingBudget(false);
    }
  };

  if (canManage !== true) {
    return null;
  }

  const current = status.status === "loaded" ? status.data.budgetCents : null;

  return (
    <div className="grid gap-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-950">Organization default run budget</h2>
        <p className={`mt-1 ${MUTED}`}>
          Set a per-run budget (USD) for AgentKitAuto runs started by your members. When set, this OVERRIDES each member&apos;s own
          default budget. Leave it unset to let members use their own default.
        </p>
      </div>

      {status.status === "loading" && <p className={MUTED}>Loading run budget…</p>}
      {status.status === "failed" && <div className={DANGER}>{status.message}</div>}
      {status.status === "loaded" && (
        <div className={PANEL}>
          <strong className="text-slate-950">
            {current !== null ? `Current org default: $${(current / 100).toFixed(2)} per run` : "No org default set"}
          </strong>
          {current === null && <p className={`mt-1 ${MUTED}`}>Members use their own default run budget.</p>}
        </div>
      )}

      <form className={`${PANEL} grid gap-4`} onSubmit={(e) => { void handleSave(e); }}>
        <h3 className="text-lg font-semibold text-slate-950">Set the org default</h3>
        {formError && <div className={DANGER}>{formError}</div>}
        {formNotice && <div className={NOTICE}>{formNotice}</div>}
        <label className={LABEL}>
          Default run budget (USD) *
          <Input type="number" min="0.01" step="0.01" value={budgetUsd} onChange={(e) => setBudgetUsd(e.target.value)} placeholder="0.50" disabled={saving} />
        </label>
        <div className="flex gap-3">
          <Button type="submit" disabled={saving || !budgetUsd.trim()}>
            {saving ? "Saving…" : "Save budget"}
          </Button>
          {current !== null && (
            <Button type="button" variant="danger" disabled={clearingBudget} onClick={() => { void handleClear(); }}>
              {clearingBudget ? "Clearing…" : "Clear org default"}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
