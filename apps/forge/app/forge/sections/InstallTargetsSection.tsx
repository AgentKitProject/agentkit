"use client";

// Install Targets section — export a kit to Claude Code or Codex with the
// desktop's "install target" framing: what each target does, a brief explainer,
// and a dedicated download action. Reuses the existing export routes.

import { useState } from "react";
import { Button, Field, Select } from "@agentkitforge/ui";
import { PlugIcon } from "../icons";
import type { Forge, MyKitEntry, Notify } from "./shared";
import { errMsg } from "./shared";

const TARGETS = [
  {
    id: "claude-code" as const,
    label: "Claude Code",
    description:
      "Export this kit as a Claude Code project layout (a CLAUDE.md + skill files). Drop it into your project directory and Claude Code will load the kit context when you start a session.",
    actionLabel: "Export → Claude Code",
    hint: "Produces a .zip you extract into a project folder. Claude Code reads CLAUDE.md on startup."
  },
  {
    id: "codex" as const,
    label: "Codex",
    description:
      "Export kit skills as a Codex skills directory. Each skill becomes a folder that Codex picks up from its configured skills path.",
    actionLabel: "Export → Codex",
    hint: "Produces a .zip containing one sub-folder per skill, ready to unzip into your Codex skills directory."
  }
];

export function InstallTargetsSection({
  forge,
  kits,
  notify
}: {
  forge: Forge;
  kits: MyKitEntry[];
  notify: Notify;
}) {
  const [kitId, setKitId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const act = (targetId: string, fn: () => Promise<unknown>) => async () => {
    setBusy(targetId);
    try {
      await fn();
      notify("Export downloaded.");
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="install-targets-screen">
      <div className="form-panel" style={{ maxWidth: 560 }}>
        <h2>Install targets</h2>
        <p className="form-copy">
          Export your kit directly into an agent runtime. Choose a kit, then pick a target — each export
          downloads a ready-to-install archive.
        </p>
        <Field label="Kit to export">
          <Select value={kitId} onChange={(e) => setKitId(e.target.value)}>
            <option value="">Select a kit…</option>
            {kits.map((k) => (
              <option key={k.kitId} value={k.kitId}>{k.name ?? k.kitId}</option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="screen-grid compact">
        {TARGETS.map((t) => (
          <div key={t.id} className="placeholder-card">
            <span className="card-icon"><PlugIcon size={20} /></span>
            <h2>{t.label}</h2>
            <p>{t.description}</p>
            <p className="form-copy" style={{ fontSize: "0.82em", fontStyle: "italic", marginBottom: 12 }}>{t.hint}</p>
            <Button
              disabled={!kitId || busy !== null}
              loading={busy === t.id}
              onClick={
                t.id === "claude-code"
                  ? act(t.id, () => forge.exportAgentKitToClaudeCode({ kitPath: kitId, destinationDir: "", force: true }))
                  : act(t.id, () => forge.exportAgentKitToCodex({ kitPath: kitId, destinationSkillsDir: "", force: true }))
              }
            >
              {busy === t.id ? "Exporting…" : t.actionLabel}
            </Button>
          </div>
        ))}
      </div>

      <div className="form-panel" style={{ maxWidth: 560, marginTop: 24 }}>
        <h2 style={{ fontSize: "0.95em", marginBottom: 6 }}>Also available: package &amp; one-file exports</h2>
        <p className="form-copy">
          Need a portable <span className="inline-code">.agentkit.zip</span> or a single Markdown file?
          Those are in the <strong>Package / Export</strong> section.
        </p>
      </div>
    </div>
  );
}
