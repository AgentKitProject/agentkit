"use client";

import { useEffect, useState } from "react";
import { Button, Field, Input, Select, Textarea } from "@agentkitforge/ui";
import type { Forge, MyKitEntry, Notify } from "./shared";
import { errMsg } from "./shared";

type PreparedPromptInput = {
  id: string;
  label?: string;
  type?: "short-text" | "long-text" | "choice" | "multi-choice" | "date" | "number" | "boolean";
  required?: boolean;
  placeholder?: string;
  defaultValue?: unknown;
  choices?: string[];
};

type PreparedPromptFull = {
  id: string;
  name?: string;
  description?: string;
  inputs?: PreparedPromptInput[];
  template?: string;
  outputMode?: string;
};

// Run parameters match the desktop's PreparedPromptRenderOptions
type RunParams = {
  contextMode: "all" | "triggered";
  includePolicies: boolean;
  includeTemplates: boolean;
  includeWorkflows: boolean;
  includePreparedPrompts: boolean;
  validationProfile: "local-valid" | "publishable" | "trusted" | "verified";
  validateBeforeRender: boolean;
};

const DEFAULT_RUN_PARAMS: RunParams = {
  contextMode: "all",
  includePolicies: true,
  includeTemplates: true,
  includeWorkflows: true,
  includePreparedPrompts: false,
  validationProfile: "local-valid",
  validateBeforeRender: false
};

export function UseSection({ forge, kits, notify }: { forge: Forge; kits: MyKitEntry[]; notify: Notify }) {
  const [kitId, setKitId] = useState<string>("");
  const [prompts, setPrompts] = useState<PreparedPromptFull[]>([]);
  const [promptId, setPromptId] = useState<string>("");
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({});
  const [rendered, setRendered] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [runParams, setRunParams] = useState<RunParams>(DEFAULT_RUN_PARAMS);

  // Load prompts when kit changes
  useEffect(() => {
    if (!kitId) {
      setPrompts([]);
      setHint("");
      return;
    }
    void forge.listPreparedPrompts(kitId).then(
      (p) => setPrompts(p as PreparedPromptFull[]),
      (e) => notify(errMsg(e), true)
    );
    // Load starter hint from START_HERE.md
    void fetch(`/api/kits/${encodeURIComponent(kitId)}/tree`, { credentials: "include" })
      .then((r) => r.json())
      .then((res: { tree?: { files?: { path: string; content: string }[] } }) => {
        const startHere = res.tree?.files?.find((f) => f.path === "START_HERE.md");
        if (startHere) setHint(startHere.content.slice(0, 600));
      })
      .catch(() => {/* non-critical */});
  }, [kitId, forge, notify]);

  // Reset input values when prompt changes
  useEffect(() => {
    const prompt = prompts.find((p) => p.id === promptId);
    if (!prompt) {
      setInputValues({});
      return;
    }
    const defaults: Record<string, unknown> = {};
    for (const inp of prompt.inputs ?? []) {
      if (inp.defaultValue !== undefined) defaults[inp.id] = inp.defaultValue;
    }
    setInputValues(defaults);
  }, [promptId, prompts]);

  const selectedPrompt = prompts.find((p) => p.id === promptId);

  const render = async () => {
    if (!kitId || !promptId) return;
    setBusy(true);
    try {
      const res = await forge.renderPreparedPrompt({
        rootPath: kitId,
        promptId,
        inputValues,
        // Pass run params through as extra options; the server can use what it supports
        ...(showAdvanced ? { options: runParams } : {})
      } as never);
      const r = res as { text?: string; prompt?: string; result?: { rendered?: string; text?: string } };
      setRendered(r.text ?? r.prompt ?? (r.result as { rendered?: string; text?: string } | undefined)?.rendered ?? (r.result as { text?: string } | undefined)?.text ?? JSON.stringify(res, null, 2));
      notify("Prompt rendered.");
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  const copyToClipboard = async () => {
    if (!rendered) return;
    try {
      await navigator.clipboard.writeText(rendered);
      notify("Copied to clipboard.");
    } catch {
      notify("Could not copy to clipboard.", true);
    }
  };

  const downloadText = () => {
    if (!rendered) return;
    const blob = new Blob([rendered], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${promptId || "rendered-prompt"}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const setParam = <K extends keyof RunParams>(key: K, value: RunParams[K]) =>
    setRunParams((p) => ({ ...p, [key]: value }));

  return (
    <div className="use-screen">
      <div className="form-layout">
        <div className="form-panel">
          <h2>Run a prepared prompt</h2>
          <p className="form-copy">Pick a kit and one of its prepared prompts, fill in the inputs, and render the final prompt text.</p>
          <Field label="Kit">
            <Select value={kitId} onChange={(e) => { setKitId(e.target.value); setPromptId(""); setRendered(""); }}>
              <option value="">Select a kit…</option>
              {kits.map((k) => (
                <option key={k.kitId} value={k.kitId}>{k.name ?? k.kitId}</option>
              ))}
            </Select>
          </Field>

          {hint && (
            <div className="results-panel" style={{ marginBottom: 12, padding: "10px 14px" }}>
              <p style={{ fontWeight: 600, marginBottom: 4, fontSize: "0.88em" }}>Starter hint</p>
              <pre style={{ fontSize: "0.8em", whiteSpace: "pre-wrap", margin: 0 }}>{hint}</pre>
            </div>
          )}

          <Field label="Prepared prompt">
            <Select value={promptId} onChange={(e) => setPromptId(e.target.value)} disabled={!prompts.length}>
              <option value="">{prompts.length ? "Select a prompt…" : "No prepared prompts"}</option>
              {prompts.map((p) => (
                <option key={p.id} value={p.id}>{p.name ?? p.id}</option>
              ))}
            </Select>
          </Field>

          {selectedPrompt?.description && (
            <p className="form-copy" style={{ fontStyle: "italic" }}>{selectedPrompt.description}</p>
          )}

          {/* Render schema-based inputs if available, else fallback to raw JSON */}
          {selectedPrompt?.inputs && selectedPrompt.inputs.length > 0 ? (
            <PreparedPromptInputFields
              inputs={selectedPrompt.inputs}
              values={inputValues}
              onChange={(id, val) => setInputValues((v) => ({ ...v, [id]: val }))}
            />
          ) : promptId ? (
            <Field label="Input values (JSON)">
              <Textarea
                value={typeof inputValues === "object" ? JSON.stringify(inputValues, null, 2) : "{}"}
                onChange={(e) => {
                  try { setInputValues(JSON.parse(e.target.value) as Record<string, unknown>); } catch { /* invalid JSON while typing */ }
                }}
                style={{ minHeight: 120, fontFamily: "var(--mono, monospace)" }}
              />
            </Field>
          ) : null}

          {/* Advanced run parameters */}
          <div style={{ marginTop: 12 }}>
            <Button
              type="button"
              variant="secondary"
              style={{ fontSize: "0.82em" }}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? "▾" : "▸"} Run parameters
            </Button>
            {showAdvanced && (
              <div className="provider-card" style={{ marginTop: 8 }}>
                <Field label="Context mode">
                  <Select
                    value={runParams.contextMode}
                    onChange={(e) => setParam("contextMode", e.target.value as RunParams["contextMode"])}
                    style={{ fontSize: "0.88em" }}
                  >
                    <option value="all">All skills (full context)</option>
                    <option value="triggered">Triggered (best-matching skills first)</option>
                  </Select>
                </Field>
                <Field label="Validation profile">
                  <Select
                    value={runParams.validationProfile}
                    onChange={(e) => setParam("validationProfile", e.target.value as RunParams["validationProfile"])}
                    style={{ fontSize: "0.88em" }}
                  >
                    <option value="local-valid">local-valid</option>
                    <option value="publishable">publishable</option>
                    <option value="trusted">trusted</option>
                    <option value="verified">verified</option>
                  </Select>
                </Field>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                  {([
                    ["validateBeforeRender", "Validate kit before rendering"],
                    ["includePolicies", "Include policies in context"],
                    ["includeTemplates", "Include templates in context"],
                    ["includeWorkflows", "Include workflows in context"],
                    ["includePreparedPrompts", "Include prepared prompts in context"]
                  ] as [keyof RunParams, string][]).map(([key, label]) => (
                    <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "0.88em" }}>
                      <input
                        type="checkbox"
                        checked={!!runParams[key]}
                        onChange={(e) => setParam(key, e.target.checked as RunParams[typeof key])}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          <Button
            style={{ marginTop: 12 }}
            disabled={!kitId || !promptId || busy}
            loading={busy}
            onClick={() => void render()}
          >
            {busy ? "Rendering…" : "Render prompt"}
          </Button>
        </div>
        <div className="results-panel">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Rendered prompt</h2>
            {rendered && (
              <div className="button-row" style={{ margin: 0, gap: 6 }}>
                <Button variant="secondary" style={{ fontSize: "0.8em", padding: "3px 10px" }} onClick={() => void copyToClipboard()}>Copy</Button>
                <Button variant="secondary" style={{ fontSize: "0.8em", padding: "3px 10px" }} onClick={downloadText}>Download</Button>
              </div>
            )}
          </div>
          {rendered ? <pre className="json-panel" style={{ whiteSpace: "pre-wrap" }}>{rendered}</pre> : <p>Select a kit and a prepared prompt to render its final text.</p>}
        </div>
      </div>
    </div>
  );
}

function PreparedPromptInputFields({
  inputs,
  values,
  onChange
}: {
  inputs: PreparedPromptInput[];
  values: Record<string, unknown>;
  onChange: (id: string, value: unknown) => void;
}) {
  return (
    <>
      {inputs.map((inp) => (
        <PreparedPromptInputField key={inp.id} input={inp} value={values[inp.id]} onChange={(v) => onChange(inp.id, v)} />
      ))}
    </>
  );
}

function PreparedPromptInputField({
  input,
  value,
  onChange
}: {
  input: PreparedPromptInput;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (
    <label>
      {input.label ?? input.id}
      {input.required && <span style={{ color: "var(--color-error)", marginLeft: 3 }}>*</span>}
    </label>
  );

  const type = input.type ?? "short-text";
  const strVal = typeof value === "string" ? value : (value != null ? String(value) : "");

  if (type === "long-text") {
    return (
      <Field>
        {label}
        <Textarea value={strVal} onChange={(e) => onChange(e.target.value)} placeholder={input.placeholder} style={{ minHeight: 100 }} />
      </Field>
    );
  }

  if (type === "choice" && input.choices?.length) {
    return (
      <Field>
        {label}
        <Select value={strVal} onChange={(e) => onChange(e.target.value)}>
          {!input.required && <option value="">—</option>}
          {input.choices.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </Field>
    );
  }

  if (type === "multi-choice" && input.choices?.length) {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    const toggle = (c: string) => {
      const next = selected.includes(c) ? selected.filter((x) => x !== c) : [...selected, c];
      onChange(next);
    };
    return (
      <Field>
        {label}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {input.choices.map((c) => (
            <label key={c} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input type="checkbox" checked={selected.includes(c)} onChange={() => toggle(c)} /> {c}
            </label>
          ))}
        </div>
      </Field>
    );
  }

  if (type === "boolean") {
    return (
      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {input.label ?? input.id}
          {input.required && <span style={{ color: "var(--color-error)" }}>*</span>}
        </label>
      </div>
    );
  }

  if (type === "number") {
    return (
      <Field>
        {label}
        <Input type="number" value={strVal} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} placeholder={input.placeholder} />
      </Field>
    );
  }

  if (type === "date") {
    return (
      <Field>
        {label}
        <Input type="date" value={strVal} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  }

  // default: short-text
  return (
    <Field>
      {label}
      <Input value={strVal} onChange={(e) => onChange(e.target.value)} placeholder={input.placeholder} />
    </Field>
  );
}
