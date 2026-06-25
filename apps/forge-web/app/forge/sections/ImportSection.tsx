"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Field, Input } from "@agentkitforge/ui";
import { StarIcon } from "../icons";
import type { Forge, Notify } from "./shared";
import { errMsg } from "./shared";
import { useConfig } from "../config-context";

type ImportTab = "zip" | "git" | "market" | "browse" | "org";

type MarketKitEntry = {
  slug: string;
  name?: string;
  summary?: string;
  publisher?: string;
  version?: number | string;
  categories?: string[];
  tags?: string[];
  downloadCount?: number;
};

type OrgEntry = {
  id: string;
  name: string;
  role?: string;
  memberCount?: number;
};

export function ImportSection({
  forge,
  notify,
  onDone
}: {
  forge: Forge;
  notify: Notify;
  onDone: (kitId?: string) => void;
}) {
  const { marketEnabled, links } = useConfig();
  const [tab, setTab] = useState<ImportTab>("zip");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [ref, setRef] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      const result = await fn();
      notify(ok);
      const kitId = (result && typeof result === "object" && "kitId" in result) ? String((result as { kitId: string }).kitId) : undefined;
      onDone(kitId);
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="import-screen">
      <div className="segmented-control" role="tablist">
        {(([
          ["zip", "Upload .agentkit.zip"],
          ["git", "From Git"],
          // Market import tabs only when a Market is configured on this instance.
          ...(marketEnabled
            ? ([
                ["market", "From Market (slug)"],
                ["browse", "Browse Market"],
                ["org", "Org Kits"]
              ] as [ImportTab, string][])
            : [])
        ] as [ImportTab, string][])).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`segment-button ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      <div className="build-layout" style={{ marginTop: 18 }}>
        {tab === "zip" && (
          <div className="form-panel">
            <h2>Upload a package</h2>
            <p className="form-copy">Import an existing <span className="inline-code">.agentkit.zip</span> into <strong>My Kits</strong> (your library). The kit is saved to your account and will appear in My Kits after import.</p>
            <div className="field">
              <label>Package file</label>
              <input type="file" accept=".zip" onChange={(e) => setZipFile(e.target.files?.[0] ?? null)} />
            </div>
            <Button disabled={!zipFile || busy} loading={busy} onClick={() => run(() => forge.importAgentKitPackage({ file: zipFile } as never), "Imported from zip.")}>
              {busy ? "Importing…" : "Import zip"}
            </Button>
          </div>
        )}
        {tab === "git" && (
          <div className="form-panel">
            <h2>Import from a Git repository</h2>
            <p className="form-copy">Clone a public repository that contains an Agent Kit and save it to <strong>My Kits</strong> (your library). The kit is persisted to your account.</p>
            <Field label="Repository URL">
              <Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/org/repo.git" />
            </Field>
            <Field label="Ref (optional)">
              <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" />
            </Field>
            <Button
              disabled={!repoUrl || busy}
              loading={busy}
              onClick={() => run(() => forge.importAgentKitFromGit({ repositoryUrl: repoUrl, reference: ref, destinationRootFolder: "", validationProfile: "local-valid" }), "Imported from Git.")}
            >
              {busy ? "Importing…" : "Import git"}
            </Button>
          </div>
        )}
        {tab === "market" && (
          <div className="form-panel">
            <h2>Import from AgentKitMarket</h2>
            <p className="form-copy"><strong>Import</strong> downloads the kit into <strong>My Kits</strong> (your library) so you can edit, validate, and package it. <strong>Favorite</strong> saves a reference so you can track updates without downloading a copy.</p>
            <Field label="Market slug">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="financial-review" />
            </Field>
            <div className="button-row">
              <Button disabled={!slug || busy} onClick={() => run(() => forge.importHostedMarketKit({ slug, marketBaseUrl: "", validationProfile: "local-valid" }), "Imported from Market.")}>
                Import
              </Button>
              <Button
                variant="secondary"
                disabled={!slug || busy}
                onClick={() =>
                  run(async () => {
                    const r = await fetch("/api/favorites", {
                      method: "POST",
                      credentials: "include",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ marketSlug: slug })
                    });
                    if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? "Failed");
                  }, "Favorited.")
                }
              >
                <StarIcon size={14} /> Favorite
              </Button>
            </div>
          </div>
        )}
        {tab === "browse" && (
          <MarketBrowsePanel forge={forge} notify={notify} onDone={onDone} busy={busy} setBusy={setBusy} />
        )}
        {tab === "org" && (
          <OrgKitsPanel forge={forge} notify={notify} onDone={onDone} busy={busy} setBusy={setBusy} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Org kits panel
// ---------------------------------------------------------------------------

type OrgKitEntry = {
  kitId: string;
  slug: string;
  name?: string;
  summary?: string;
  visibility?: string;
  currentVersion?: number;
  publisherId?: string;
};

function OrgKitsPanel({
  forge,
  notify,
  onDone,
  busy,
  setBusy
}: {
  forge: Forge;
  notify: Notify;
  onDone: (kitId?: string) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { links } = useConfig();
  const [orgs, setOrgs] = useState<OrgEntry[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<OrgEntry | null>(null);
  const [kits, setKits] = useState<OrgKitEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [kitsLoading, setKitsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kitsError, setKitsError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch("/api/market/orgs", { credentials: "include" })
      .then(async (res) => {
        const data = (await res.json()) as { orgs?: OrgEntry[]; error?: string };
        if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
        setOrgs(data.orgs ?? []);
      })
      .catch((e: unknown) => setError(errMsg(e)))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadOrgKits = (org: OrgEntry) => {
    setSelectedOrg(org);
    setKits([]);
    setKitsError(null);
    setKitsLoading(true);
    fetch(`/api/market/orgs/${encodeURIComponent(org.id)}/kits`, { credentials: "include" })
      .then(async (res) => {
        const data = (await res.json()) as { items?: OrgKitEntry[]; error?: string };
        if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
        setKits(data.items ?? []);
      })
      .catch((e: unknown) => setKitsError(errMsg(e)))
      .finally(() => setKitsLoading(false));
  };

  const importKit = async (slug: string) => {
    setBusy(true);
    try {
      const result = await forge.importHostedMarketKit({ slug, marketBaseUrl: "", validationProfile: "local-valid" });
      notify(`Imported "${slug}".`);
      const kitId = (result && typeof result === "object" && "kitId" in result) ? String((result as { kitId: string }).kitId) : undefined;
      onDone(kitId);
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  const favoriteKit = async (slug: string) => {
    try {
      const r = await fetch("/api/favorites", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ marketSlug: slug })
      });
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? "Failed");
      notify(`Favorited "${slug}".`);
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  if (loading) {
    return <p className="form-copy">Loading your organizations…</p>;
  }

  if (error) {
    return (
      <div className="form-panel">
        <h2>Org kits</h2>
        <p className="inline-warning">{error}</p>
        <p className="form-copy">Make sure you are signed in. If the error persists, try signing out and back in.</p>
      </div>
    );
  }

  if (orgs.length === 0) {
    return (
      <div className="form-panel">
        <h2>Org kits</h2>
        <p className="form-copy">You are not a member of any AgentKitMarket organization.</p>
        <p className="form-copy">Once your organization is on AgentKitMarket, org-owned kits will be available to import here. Public kits from the Market catalog are available in the <strong>Browse Market</strong> tab.</p>
      </div>
    );
  }

  return (
    <div style={{ width: "100%" }}>
      <h2>Org kits</h2>
      <p className="form-copy">
        Select an organization to browse its kits, including private ones you have access to.
      </p>

      <div className="kit-list">
        {orgs.map((org) => (
          <article className="kit-library-card" key={org.id}>
            <div className="kit-library-main">
              <div>
                <h2>{org.name}</h2>
                <p className="form-copy" style={{ margin: "2px 0" }}>
                  <span className="inline-code">{org.id}</span>
                  {org.role && <span> · {org.role}</span>}
                  {org.memberCount != null && <span> · {org.memberCount} member{org.memberCount !== 1 ? "s" : ""}</span>}
                </p>
              </div>
            </div>
            <div className="button-row">
              <Button
                variant="secondary"
                onClick={() => loadOrgKits(org)}
                disabled={kitsLoading && selectedOrg?.id === org.id}
              >
                {kitsLoading && selectedOrg?.id === org.id ? "Loading…" : "Browse kits"}
              </Button>
              {links.marketUrl && (
                <Button
                  variant="secondary"
                  href={`${links.marketUrl}/orgs/${encodeURIComponent(org.id)}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ textDecoration: "none" }}
                >
                  View on Market
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>

      {selectedOrg && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ marginBottom: 4 }}>{selectedOrg.name} — kits</h2>
          {kitsLoading && <p className="form-copy">Loading kits…</p>}
          {kitsError && <p className="inline-warning">{kitsError}</p>}
          {!kitsLoading && !kitsError && kits.length === 0 && (
            <p className="form-copy">This organization has no kits yet.</p>
          )}
          {kits.length > 0 && (
            <div className="kit-list">
              {kits.map((k) => (
                <article className="kit-library-card" key={k.kitId}>
                  <div className="kit-library-main">
                    <div>
                      <h2>{k.name ?? k.slug}</h2>
                      {k.summary && <p>{k.summary}</p>}
                      <p className="form-copy" style={{ margin: "2px 0" }}>
                        <span className="inline-code">{k.slug}</span>
                        {k.currentVersion != null && <span> · v{k.currentVersion}</span>}
                        {k.visibility === "private" && (
                          <Badge tone="neutral" style={{ marginLeft: 6 }}>private</Badge>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="button-row">
                    <Button disabled={busy} onClick={() => void importKit(k.slug)}>Import</Button>
                    <Button variant="secondary" disabled={busy} onClick={() => void favoriteKit(k.slug)}>
                      <StarIcon size={13} /> Favorite
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browse Market panel
// ---------------------------------------------------------------------------
function MarketBrowsePanel({
  forge,
  notify,
  onDone,
  busy,
  setBusy
}: {
  forge: Forge;
  notify: Notify;
  onDone: (kitId?: string) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { links } = useConfig();
  const [kits, setKits] = useState<MarketKitEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);

  const loadPage = async (cursor?: string, q?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (q?.trim()) params.set("q", q.trim());
      params.set("limit", "24");
      const res = await fetch(`/api/market/catalog?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed to load catalog");
      const data = (await res.json()) as { kits?: MarketKitEntry[]; nextCursor?: string };
      const incoming = data.kits ?? [];
      if (!cursor) {
        setKits(incoming);
      } else {
        setKits((prev) => [...prev, ...incoming]);
      }
      setNextCursor(data.nextCursor);
      setHasMore(!!data.nextCursor);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void loadPage(undefined, search);
  };

  const importKit = async (slug: string) => {
    setBusy(true);
    try {
      const result = await forge.importHostedMarketKit({ slug, marketBaseUrl: "", validationProfile: "local-valid" });
      notify(`Imported "${slug}".`);
      const kitId = (result && typeof result === "object" && "kitId" in result) ? String((result as { kitId: string }).kitId) : undefined;
      onDone(kitId);
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  const favoriteKit = async (slug: string) => {
    try {
      const r = await fetch("/api/favorites", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ marketSlug: slug })
      });
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? "Failed");
      notify(`Favorited "${slug}".`);
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  return (
    <div style={{ width: "100%" }}>
      <h2>Browse AgentKitMarket</h2>
      <p className="form-copy">Browse the public kit catalog. Import to add to your library, or Favorite to track updates.</p>
      <form onSubmit={(e) => void handleSearch(e)} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search kits…"
          style={{ flex: 1 }}
        />
        <Button type="submit" variant="secondary" disabled={loading}>Search</Button>
        {search && <Button type="button" variant="secondary" onClick={() => { setSearch(""); void loadPage(); }}>Clear</Button>}
      </form>

      {error && <p className="inline-warning">{error}</p>}
      {loading && kits.length === 0 && <p className="form-copy">Loading catalog…</p>}

      {kits.length > 0 && (
        <div className="kit-list">
          {kits.map((k) => (
            <article className="kit-library-card" key={k.slug}>
              <div className="kit-library-main">
                <div>
                  <h2>{k.name ?? k.slug}</h2>
                  {k.summary && <p>{k.summary}</p>}
                  <p className="form-copy" style={{ margin: "2px 0" }}>
                    {k.publisher && <span>{k.publisher} · </span>}
                    <span className="inline-code">{k.slug}</span>
                    {k.version != null && <span> · v{k.version}</span>}
                    {k.downloadCount != null && <span> · {k.downloadCount} downloads</span>}
                  </p>
                  {k.categories && k.categories.length > 0 && (
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                      {k.categories.map((c) => <Badge key={c} tone="neutral">{c}</Badge>)}
                    </div>
                  )}
                </div>
              </div>
              <div className="button-row">
                <Button disabled={busy} onClick={() => void importKit(k.slug)}>Import</Button>
                <Button variant="secondary" disabled={busy} onClick={() => void favoriteKit(k.slug)}>
                  <StarIcon size={13} /> Favorite
                </Button>
                {links.marketUrl && (
                  <Button
                    variant="secondary"
                    href={`${links.marketUrl}/kits/${k.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: "none" }}
                  >
                    View on Market
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {!loading && kits.length === 0 && !error && (
        <div className="empty-state">
          <p>No kits found{search ? ` for "${search}"` : ""}.</p>
        </div>
      )}

      {hasMore && (
        <div style={{ marginTop: 16, textAlign: "center" }}>
          <Button variant="secondary" disabled={loading} onClick={() => void loadPage(nextCursor, search || undefined)}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
