"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Select } from "@agentkitforge/ui";
import { FileIcon, PackageIcon, PlugIcon } from "../icons";
import type { Forge, Notify, ValidationReport } from "./shared";
import { errMsg } from "./shared";
import { useConfig } from "../config-context";
import { AutomationsCard } from "./AutomationsCard";
import type { ForgeKitAutomation } from "./kit-automations";

type ValidationProfile = "local-valid" | "publishable" | "trusted" | "verified";

type ValidationIssue = {
  severity?: "error" | "warning";
  code?: string;
  message?: string | { message?: string };
  path?: string;
  [k: string]: unknown;
};

export function KitEditor({
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
  const { marketEnabled, links } = useConfig();
  const [files, setFiles] = useState<{ path: string; content: string; encoding?: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [profile, setProfile] = useState<ValidationProfile>("local-valid");
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [summary, setSummary] = useState<{ id?: string; name?: string; version?: string; description?: string } | null>(null);
  const [automations, setAutomations] = useState<ForgeKitAutomation[]>([]);
  const [versionInfo, setVersionInfo] = useState<{ previous?: string; next?: string } | null>(null);
  const [bumpBusy, setBumpBusy] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/kits/${encodeURIComponent(kitId)}/tree`, { credentials: "include" }).then((r) => r.json());
    const tree = ((res as { tree?: { files?: { path: string; content: string; encoding?: string }[] } }).tree?.files ?? []);
    setFiles(tree);
    setSelected((cur) => {
      if (cur) return cur;
      if (tree.length) setContent(tree[0].content);
      return tree[0]?.path ?? null;
    });
  }, [kitId]);

  const loadMeta = useCallback(async () => {
    try {
      const [sumRes, verRes] = await Promise.all([
        fetch(`/api/kits/${encodeURIComponent(kitId)}/summary`, { credentials: "include" }).then((r) => r.json()),
        fetch(`/api/kits/${encodeURIComponent(kitId)}/next-version`, { credentials: "include" }).then((r) => r.json())
      ]);
      const s = (sumRes as { summary?: { id?: string; name?: string; version?: string; description?: string } }).summary;
      setSummary(s ?? null);
      const a = (sumRes as { automations?: ForgeKitAutomation[] }).automations;
      setAutomations(Array.isArray(a) ? a : []);
      const v = (verRes as { previous?: string; next?: string });
      setVersionInfo(v);
    } catch {
      // non-critical
    }
  }, [kitId]);

  useEffect(() => {
    void load().catch((e) => notify(errMsg(e), true));
    void loadMeta();
  }, [load, loadMeta, notify]);

  const open = (path: string) => {
    const f = files.find((x) => x.path === path);
    setSelected(path);
    setContent(f?.content ?? "");
    setDirty(false);
  };

  const save = async () => {
    if (!selected) return;
    try {
      await fetch(`/api/kits/${encodeURIComponent(kitId)}/files`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: selected, content })
      });
      setDirty(false);
      notify("Saved.");
      await load();
      await loadMeta();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const bumpVersion = async () => {
    if (!versionInfo?.next) return;
    setBumpBusy(true);
    try {
      const r = await fetch(`/api/kits/${encodeURIComponent(kitId)}/version`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: versionInfo.next })
      });
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? "Failed");
      notify(`Version bumped to ${versionInfo.next}.`);
      await load();
      await loadMeta();
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBumpBusy(false);
    }
  };

  const isText = useMemo(() => {
    const f = files.find((x) => x.path === selected);
    return !f || f.encoding !== "base64";
  }, [files, selected]);

  const act = (label: string, fn: () => Promise<unknown>) => () => fn().then(() => notify(`${label} ✓`), (e) => notify(errMsg(e), true));

  return (
    <div className="build-screen">
      <div className="screen-toolbar">
        <Button variant="secondary" onClick={onClose}>← My Kits</Button>
        <div className="button-row">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setMetaOpen((o) => !o)}
            title="Kit metadata & version"
          >
            {summary?.name ?? kitId} {summary?.version && <Badge tone="neutral" style={{ marginLeft: 4 }}>v{summary.version}</Badge>}
          </Button>
          <Select style={{ width: "auto", minWidth: 150 }} value={profile} onChange={(e) => setProfile(e.target.value as ValidationProfile)}>
            <option value="local-valid">local-valid</option>
            <option value="publishable">publishable</option>
            <option value="trusted">trusted</option>
            <option value="verified">verified</option>
          </Select>
          <Button variant="secondary" onClick={() => forge.validateAgentKit({ rootPath: kitId, profile }).then(setReport, (e) => notify(errMsg(e), true))}>Validate</Button>
          <Button variant="secondary" onClick={act("Package downloaded", () => forge.packageAgentKit({ rootPath: kitId, outputFolder: "" }))}>Package</Button>
          <Button variant="secondary" onClick={act("One-file exported", () => forge.exportAgentKitOneFile({ rootPath: kitId, outputPath: "" }))}>One-file</Button>
          <Button variant="secondary" onClick={act("Claude Code export", () => forge.exportAgentKitToClaudeCode({ kitPath: kitId, destinationDir: "", force: true }))}>→ Claude Code</Button>
          <Button variant="secondary" onClick={act("Codex export", () => forge.exportAgentKitToCodex({ kitPath: kitId, destinationSkillsDir: "", force: true }))}>→ Codex</Button>
        </div>
      </div>

      {/* Kit metadata panel */}
      {metaOpen && (
        <div className="results-panel" style={{ marginBottom: 12, padding: "12px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
            <div>
              <p style={{ margin: "0 0 4px" }}><strong>ID:</strong> <span className="inline-code">{summary?.id ?? kitId}</span></p>
              {summary?.name && <p style={{ margin: "0 0 4px" }}><strong>Name:</strong> {summary.name}</p>}
              {summary?.description && <p style={{ margin: "0 0 4px" }}><strong>Description:</strong> {summary.description}</p>}
              {summary?.version && (
                <p style={{ margin: "0 0 4px" }}>
                  <strong>Version:</strong> <span className="inline-code">v{summary.version}</span>
                  {versionInfo?.next && (
                    <Button
                      variant="secondary"
                      size="sm"
                      style={{ marginLeft: 10, fontSize: "0.8em", padding: "2px 10px" }}
                      disabled={bumpBusy}
                      loading={bumpBusy}
                      onClick={() => void bumpVersion()}
                    >
                      {bumpBusy ? "Bumping…" : `Bump → v${versionInfo.next}`}
                    </Button>
                  )}
                </p>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {marketEnabled && links.marketUrl && (
                <Button variant="secondary" style={{ textDecoration: "none" }} href={`${links.marketUrl}/kits/${summary?.id ?? kitId}`} target="_blank" rel="noreferrer">
                  <StoreIconSmall /> View on Market
                </Button>
              )}
              <Button variant="secondary" onClick={() => setMetaOpen(false)}>Close</Button>
            </div>
          </div>
        </div>
      )}

      {/* Suggested automations — deep-links OUT to the AgentKitAuto wizard */}
      <AutomationsCard automations={automations} kitId={kitId} autoBaseUrl={links.autoUrl} />

      <div className="editor-layout">
        <div className="file-tree">
          {files.map((f) => (
            <button key={f.path} aria-selected={selected === f.path} onClick={() => open(f.path)}>{f.path}</button>
          ))}
        </div>
        <div>
          {selected ? (
            isText ? (
              <>
                <textarea className="code-area" value={content} onChange={(e) => { setContent(e.target.value); setDirty(true); }} />
                <div className="button-row" style={{ marginTop: 10 }}>
                  <Button disabled={!dirty} onClick={() => void save()}>Save file</Button>
                </div>
              </>
            ) : (
              <div className="empty-state" style={{ margin: 0 }}><p>Binary file ({selected}) — not editable here.</p></div>
            )
          ) : (
            <div className="empty-state" style={{ margin: 0 }}><p>No file selected.</p></div>
          )}
        </div>
      </div>

      {/* Structured validation report */}
      {report && <ValidationReportPanel report={report} profile={profile} onClose={() => setReport(null)} />}
    </div>
  );
}

// --- Structured validation report -------------------------------------------
function ValidationReportPanel({
  report,
  profile,
  onClose
}: {
  report: ValidationReport;
  profile: ValidationProfile;
  onClose: () => void;
}) {
  const isValid = !!(report.valid ?? report.ok);

  const rawIssues: ValidationIssue[] = [
    ...((report.errors ?? []) as ValidationIssue[]),
    ...((report.warnings ?? []) as ValidationIssue[])
  ];

  // Normalize issues — the core returns different shapes depending on version
  const issues = rawIssues.map((issue) => {
    let severity: "error" | "warning" = "error";
    let msg: string = "";
    let code: string | undefined;
    let path: string | undefined;

    if (typeof issue === "string") {
      msg = issue;
    } else {
      // Check if it's in the warnings list
      const inWarnings = (report.warnings ?? []).includes(issue as never);
      severity = inWarnings ? "warning" : "error";
      const rawMsg = issue.message;
      msg = typeof rawMsg === "string" ? rawMsg : (rawMsg as { message?: string } | undefined)?.message ?? JSON.stringify(issue);
      code = typeof issue.code === "string" ? issue.code : undefined;
      path = typeof issue.path === "string" ? issue.path : undefined;
    }

    return { severity, msg, code, path };
  });

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  return (
    <div className="validation-report">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div className={`status-banner ${isValid ? "valid" : "invalid"}`} style={{ flex: 1 }}>
          <strong>Validation · {profile}</strong>
          <span>{isValid ? "PASSED" : "FAILED"}</span>
        </div>
        <Button variant="secondary" style={{ flexShrink: 0 }} onClick={onClose}>Close</Button>
      </div>

      {issues.length === 0 && isValid && (
        <p className="form-copy" style={{ color: "var(--color-success)" }}>No issues found. Kit passes the {profile} profile.</p>
      )}

      {errors.length > 0 && (
        <IssueGroup title={`Errors (${errors.length})`} issues={errors} severity="error" />
      )}
      {warnings.length > 0 && (
        <IssueGroup title={`Warnings (${warnings.length})`} issues={warnings} severity="warning" />
      )}
    </div>
  );
}

function IssueGroup({
  title,
  issues,
  severity
}: {
  title: string;
  issues: { severity: "error" | "warning"; msg: string; code?: string; path?: string }[];
  severity: "error" | "warning";
}) {
  const color = severity === "error" ? "var(--color-error)" : "var(--color-warning)";
  return (
    <details open style={{ marginBottom: 10 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600, color }}>{title}</summary>
      <ul style={{ marginTop: 6, paddingLeft: 18 }}>
        {issues.map((issue, i) => (
          <li key={i} style={{ marginBottom: 6 }}>
            <span style={{ color }}>{issue.msg}</span>
            {issue.code && <span className="inline-code" style={{ marginLeft: 8, fontSize: "0.8em" }}>{issue.code}</span>}
            {issue.path && <span style={{ marginLeft: 8, color: "var(--color-text-secondary)", fontSize: "0.82em" }}>at {issue.path}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

// Tiny inline icon to avoid import chain issues
function StoreIconSmall() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ verticalAlign: "middle", marginRight: 3 }}>
      <rect x="3" y="7" width="14" height="11" rx="1" />
      <path d="M1 7l2-4h14l2 4" />
      <path d="M10 7v11" />
    </svg>
  );
}

// Suppress unused import warnings
void FileIcon;
void PackageIcon;
void PlugIcon;
