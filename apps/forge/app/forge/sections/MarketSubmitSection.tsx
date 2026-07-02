"use client";

import { useState } from "react";
import { Button, Field, Input, Textarea } from "@agentkitforge/ui";
import type { Forge, MyKitEntry, Notify } from "./shared";
import { errMsg } from "./shared";

export function MarketSubmitSection({
  kits,
  onPick
}: {
  kits: MyKitEntry[];
  onPick: (id: string) => void;
}) {
  return (
    <div className="install-targets-screen">
      <div className="form-panel" style={{ maxWidth: 640 }}>
        <h2>Submit a kit for review</h2>
        <p className="form-copy">Validates (publishable) and packages your kit, then submits it to the AgentKitMarket review queue using your signed-in account. No automatic publishing — admin review is always required.</p>
        {kits.length === 0 ? (
          <p className="inline-warning">You have no kits yet. Build or import one first.</p>
        ) : (
          <div className="kit-list">
            {kits.map((k) => (
              <article className="provider-card" key={k.kitId}>
                <h3>{k.name ?? k.kitId}</h3>
                <p className="inline-code">{k.kitId}</p>
                <div className="button-row">
                  <Button onClick={() => onPick(k.kitId)}>Submit this kit</Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function SubmitModal({
  forge,
  kitId,
  notify,
  onClose
}: {
  forge: Forge;
  kitId: string;
  notify: Notify;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ submissionId?: string; status?: string; marketLink?: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    try {
      const listingDraft = {
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(summary.trim() ? { summary: summary.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(categories.trim() ? { categories: categories.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        ...(tags.trim() ? { tags: tags.split(",").map((s) => s.trim()).filter(Boolean) } : {})
      };
      const res = (await forge.submitHostedMarketKit({ rootPath: kitId, marketBaseUrl: "", validationProfile: "publishable", listingDraft } as never)) as {
        submissionId?: string;
        status?: string;
        marketLink?: string;
      };
      setResult(res);
      notify("Submitted to Market for review.");
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <div className="modal-head">
          <h2>Submit to AgentKitMarket</h2>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
        <p className="form-copy">Listing fields are an optional draft — the server resolves the publisher from your AgentKitProfile and owns slug/version.</p>
        <Field label="Listing name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Summary (optional)"><Input value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
        <Field label="Description (optional)"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Categories (comma-separated)"><Input value={categories} onChange={(e) => setCategories(e.target.value)} /></Field>
        <Field label="Tags (comma-separated)"><Input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
        <Button disabled={busy} loading={busy} onClick={() => void submit()}>{busy ? "Submitting…" : "Submit for review"}</Button>
        {result && (
          <p className="form-copy" style={{ marginTop: 4 }}>
            Status: <strong>{result.status}</strong> · Submission {result.submissionId}
            {result.marketLink && (<> · <a href={result.marketLink} target="_blank" rel="noreferrer">view</a></>)}
          </p>
        )}
      </div>
    </div>
  );
}
