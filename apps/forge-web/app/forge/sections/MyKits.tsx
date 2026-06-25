"use client";

import { useEffect, useState } from "react";
import { Badge, Button } from "@agentkitforge/ui";
import { PackageIcon, StarIcon } from "../icons";
import type { Favorite, Forge, MyKitEntry, Notify, UsageInfo } from "./shared";
import { errMsg, fmtBytes } from "./shared";
import { useConfig } from "../config-context";

export function MyKits({
  forge,
  kits,
  favorites,
  usage,
  notify,
  onOpen,
  onSubmit,
  onBuild,
  onImport,
  onRefresh
}: {
  forge: Forge;
  kits: MyKitEntry[];
  favorites: Favorite[];
  usage: UsageInfo;
  notify: Notify;
  onOpen: (id: string) => void;
  onSubmit: (id: string) => void;
  onBuild: () => void;
  onImport: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { marketEnabled } = useConfig();
  const [preview, setPreview] = useState<{ files: string[]; texts: Record<string, string> } | null>(null);
  const [updates, setUpdates] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      favorites.map(async (f) => {
        try {
          const status = await forge.checkKitUpdate({
            slug: f.marketSlug,
            marketBaseUrl: f.marketBaseUrl,
            installedVersion: f.version ?? "1"
          });
          return [f.marketSlug, (status as { updateAvailable?: boolean; latestVersion?: string }).updateAvailable ? `Update available (v${(status as { latestVersion?: string }).latestVersion})` : ""] as const;
        } catch {
          return [f.marketSlug, ""] as const;
        }
      })
    ).then((pairs) => {
      if (!cancelled) setUpdates(Object.fromEntries(pairs.filter(([, v]) => v)));
    });
    return () => {
      cancelled = true;
    };
  }, [favorites, forge]);

  const remove = async (id: string) => {
    try {
      await forge.removeKitFromLibrary(id);
      notify("Kit removed.");
      await onRefresh();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const unfavorite = async (slug: string) => {
    await fetch("/api/favorites", {
      method: "DELETE",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marketSlug: slug })
    });
    notify("Favorite removed.");
    await onRefresh();
  };

  return (
    <div className="my-kits-screen">
      <div className="screen-toolbar">
        <div>
          <strong>{kits.length} owned (built &amp; imported) · {favorites.length} favorited</strong>
          {usage && (
            <p className="form-copy" style={{ marginTop: 2, marginBottom: 0 }}>
              {usage.kitCount}/{usage.kitLimit} kits &middot; {fmtBytes(usage.bytes)}/{fmtBytes(usage.byteLimit)} storage
              {usage.kitCount >= usage.kitLimit && (
                <span style={{ color: "var(--color-error)", marginLeft: 8 }}>Kit limit reached.</span>
              )}
            </p>
          )}
        </div>
        <div className="button-row">
          <Button variant="secondary" onClick={onImport}>Import a kit</Button>
          <Button onClick={onBuild}>Build a kit</Button>
        </div>
      </div>

      <h2 style={{ marginTop: 8 }}>Your Kits (built &amp; imported)</h2>
      {kits.length === 0 ? (
        <div className="empty-state">
          <span className="card-icon"><PackageIcon size={20} /></span>
          <h2>No kits yet</h2>
          <p>Create one with the AI builder or a template, or import an existing .agentkit.zip / Git repo / Market kit. Imported kits are saved here and persist across sessions.</p>
        </div>
      ) : (
        <div className="kit-list">
          {kits.map((k) => (
            <article className="kit-library-card" key={k.kitId}>
              <div className="kit-library-main">
                <div>
                  <h2>{k.name ?? k.kitId}</h2>
                  <p>Kit in your library. Open to edit files, validate, package, or export.</p>
                </div>
                <Badge tone="neutral">{k.source ?? "kit"}</Badge>
              </div>
              <dl className="kit-meta-grid">
                <div>
                  <dt>Kit ID</dt>
                  <dd className="inline-code">{k.kitId}</dd>
                </div>
              </dl>
              <div className="button-row">
                <Button onClick={() => onOpen(k.kitId)}>Open</Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    forge.packageAgentKit({ rootPath: k.kitId, outputFolder: "" }).then(
                      () => notify("Package downloaded."),
                      (e) => notify(errMsg(e), true)
                    )
                  }
                >
                  Package
                </Button>
                {marketEnabled && <Button variant="secondary" onClick={() => onSubmit(k.kitId)}>Submit to Market</Button>}
                <Button variant="danger" onClick={() => void remove(k.kitId)}>Remove</Button>
              </div>
            </article>
          ))}
        </div>
      )}

      <h2 style={{ marginTop: 24 }}>Favorites (Market references — read-only)</h2>
      {favorites.length === 0 ? (
        <p className="form-copy">No favorites yet. Use the Import tab → From Market → Favorite to track a Market kit&apos;s updates without copying it to your library.</p>
      ) : (
        <div className="kit-list">
          {favorites.map((f) => (
            <article className="kit-library-card" key={f.marketSlug}>
              <div className="kit-library-main">
                <div>
                  <h2>{f.displayName ?? f.marketSlug}</h2>
                  <p>{f.publisher ?? "Market"} · {f.marketSlug}</p>
                  {updates[f.marketSlug] && <p style={{ color: "var(--color-warning)" }}>↑ {updates[f.marketSlug]}</p>}
                </div>
                <Badge tone="neutral"><StarIcon size={13} filled /> favorite</Badge>
              </div>
              <div className="button-row">
                <Button
                  variant="secondary"
                  onClick={async () => {
                    try {
                      const res = await forge.fetchLicensedMarketKit({
                        slug: f.marketSlug,
                        marketBaseUrl: f.marketBaseUrl ?? "",
                        validationProfile: "local-valid"
                      });
                      setPreview((res as { preview?: { files: string[]; texts: Record<string, string> } }).preview ?? null);
                    } catch (e) {
                      notify(errMsg(e), true);
                    }
                  }}
                >
                  Preview (online)
                </Button>
                <Button variant="danger" onClick={() => void unfavorite(f.marketSlug)}>Unfavorite</Button>
              </div>
            </article>
          ))}
        </div>
      )}

      {preview && (
        <div className="results-panel" style={{ marginTop: 8 }}>
          <div className="screen-toolbar">
            <strong>In-memory licensed preview ({preview.files.length} files)</strong>
            <Button variant="secondary" onClick={() => setPreview(null)}>Close</Button>
          </div>
          <p className="form-copy">Online-only: never persisted to your library.</p>
          <ul className="preview-list">
            {preview.files.slice(0, 60).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {Object.entries(preview.texts).map(([name, content]) => (
            <details key={name} style={{ marginTop: 8 }}>
              <summary className="inline-code">{name}</summary>
              <pre className="json-panel" style={{ whiteSpace: "pre-wrap" }}>{content}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
