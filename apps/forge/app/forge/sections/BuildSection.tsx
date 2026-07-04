"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, Field, Input, Select, Textarea } from "@agentkitforge/ui";
import type { Forge, MyKitEntry, Notify, PublicProvider } from "./shared";
import { errMsg } from "./shared";
import { HttpError } from "@/forge-client";
import { CreditsPanel, InsufficientCreditsBanner } from "./CreditsPanel";
import { useConfig } from "../config-context";

// ---------------------------------------------------------------------------
// Managed model selection (GAP 2)
//
// When a user has NO BYO provider configured, AI turns run on managed prepaid
// credits and the user couldn't previously pick the model. This hook detects
// managed mode and exposes the managed model catalog + the chosen id, which is
// passed through generate/revise as `model` → runManagedTurn. BYO mode keeps
// using the provider's own model selection and ignores this entirely.
// ---------------------------------------------------------------------------
type ManagedModel = {
  id: string;
  label: string;
  tier: "cheaper" | "standard" | "premium";
  provider: "anthropic" | "openai";
};

const TIER_HINT: Record<ManagedModel["tier"], string> = {
  cheaper: "cheaper",
  standard: "standard",
  premium: "premium"
};

const PROVIDER_GROUP_LABEL: Record<ManagedModel["provider"], string> = {
  anthropic: "Claude",
  openai: "OpenAI (GPT)"
};

// Groups managed models by provider, preserving each group's first-seen order.
function groupModelsByProvider(models: ManagedModel[]): [ManagedModel["provider"], ManagedModel[]][] {
  const groups = new Map<ManagedModel["provider"], ManagedModel[]>();
  for (const m of models) {
    const list = groups.get(m.provider);
    if (list) list.push(m);
    else groups.set(m.provider, [m]);
  }
  return [...groups.entries()];
}

function useManagedModel() {
  // managed === user has no BYO provider configured. `undefined` while loading.
  const [managed, setManaged] = useState<boolean | undefined>(undefined);
  const [models, setModels] = useState<ManagedModel[]>([]);
  const [model, setModel] = useState<string>("");

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const provRes = await fetch("/api/settings/ai-providers", { credentials: "include" }).then((r) => r.json());
        const providers = (provRes as { providers?: PublicProvider[] }).providers ?? [];
        const isManaged = providers.length === 0;
        if (!live) return;
        setManaged(isManaged);
        if (isManaged) {
          const m = await fetch("/api/managed/models", { credentials: "include" }).then((r) => r.json());
          const list = (m as { models?: ManagedModel[]; defaultModel?: string }).models ?? [];
          if (!live) return;
          setModels(list);
          setModel((m as { defaultModel?: string }).defaultModel ?? list[1]?.id ?? list[0]?.id ?? "");
        }
      } catch {
        if (live) setManaged(false); // fail open to BYO/provider-driven path
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Only send a model when on managed mode (BYO uses the provider's own model).
  const modelForRequest = managed ? model || undefined : undefined;
  return { managed, models, model, setModel, modelForRequest };
}

function ManagedModelSelector({
  managed,
  models,
  model,
  setModel
}: {
  managed: boolean | undefined;
  models: ManagedModel[];
  model: string;
  setModel: (id: string) => void;
}) {
  if (!managed || models.length === 0) return null;
  return (
    <div className="field" style={{ marginTop: 12 }}>
      <label>
        Managed AI model{" "}
        <span style={{ fontWeight: 400, color: "var(--color-text-secondary)", fontSize: "0.88em" }}>
          (billed to prepaid credits)
        </span>
      </label>
      <Select value={model} onChange={(e) => setModel(e.target.value)}>
        {groupModelsByProvider(models).map(([provider, group]) => (
          <optgroup key={provider} label={PROVIDER_GROUP_LABEL[provider]}>
            {group.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {TIER_HINT[m.tier]}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
    </div>
  );
}

type InsufficientCredits = {
  message: string;
  requiredCents?: number;
  balanceCents?: number;
  currency?: string;
};

// Extracts a 402 insufficient-credits payload from a thrown error, else null.
function asInsufficientCredits(e: unknown): InsufficientCredits | null {
  if (e instanceof HttpError && e.status === 402) {
    const body = (e.body ?? {}) as Record<string, unknown>;
    if (body.code === "insufficient_credits") {
      return {
        message: typeof body.message === "string" ? body.message : e.message,
        requiredCents: typeof body.requiredCents === "number" ? body.requiredCents : undefined,
        balanceCents: typeof body.balanceCents === "number" ? body.balanceCents : undefined,
        currency: "USD"
      };
    }
  }
  return null;
}

type BuildTab = "ai" | "template" | "draft" | "guided" | "edit-ai";

export function BuildSection({
  forge,
  notify,
  kits,
  onOpen
}: {
  forge: Forge;
  notify: Notify;
  kits: MyKitEntry[];
  onOpen: (id: string) => void;
}) {
  const [tab, setTab] = useState<BuildTab>("ai");
  return (
    <div className="build-screen">
      <div className="segmented-control" role="tablist">
        {([
          ["ai", "Build with AI"],
          ["guided", "Guided"],
          ["template", "From template"],
          ["draft", "From draft JSON"],
          ["edit-ai", "Edit with AI"]
        ] as [BuildTab, string][]).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`segment-button ${tab === id ? "active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "ai" && <BuildWithAi forge={forge} notify={notify} onOpen={onOpen} />}
      {tab === "guided" && <GuidedBuilder forge={forge} notify={notify} onOpen={onOpen} />}
      {tab === "template" && <BuildFromTemplate forge={forge} notify={notify} onOpen={onOpen} />}
      {tab === "draft" && <RenderDraftJson forge={forge} notify={notify} onOpen={onOpen} />}
      {tab === "edit-ai" && <EditWithAi forge={forge} notify={notify} kits={kits} onOpen={onOpen} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Example document upload + summarize
// ---------------------------------------------------------------------------
type ExDocSummary = {
  id: string;
  name: string;
  filename: string;
  kind: string;
  notes?: string;
};

function ExampleDocsPanel({
  summaries,
  onAdd,
  onRemove
}: {
  summaries: ExDocSummary[];
  onAdd: (s: ExDocSummary) => void;
  onRemove: (id: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setErr(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("file", f);
      const res = await fetch("/api/drafts/summarize-examples", {
        method: "POST",
        credentials: "include",
        body: form
      });
      const data = (await res.json()) as { summaries?: ExDocSummary[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
      for (const s of data.summaries ?? []) onAdd(s);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="field" style={{ marginTop: 12 }}>
      <label>Example input documents <span style={{ fontWeight: 400, color: "var(--color-text-secondary)", fontSize: "0.88em" }}>(optional)</span></label>
      <p className="form-copy" style={{ marginBottom: 6 }}>
        Upload sample .txt / .md / .csv files so the AI can match your expected formatting and terminology.
        Max 256 KB per file.
      </p>
      {summaries.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {summaries.map((s) => (
            <div key={s.id} className="provider-card" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", marginBottom: 4 }}>
              <Badge tone="neutral">{s.kind}</Badge>
              <span style={{ flex: 1, fontSize: "0.9em" }}>{s.filename}</span>
              <Button
                variant="danger"
                size="sm"
                style={{ fontSize: "0.78em", padding: "2px 8px" }}
                onClick={() => onRemove(s.id)}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="button-row">
        <Button
          variant="secondary"
          disabled={uploading}
          loading={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? "Uploading…" : "+ Attach document"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,.csv"
          multiple
          style={{ display: "none" }}
          onChange={(e) => void upload(e.target.files)}
        />
      </div>
      {err && <p className="inline-warning" style={{ marginTop: 6 }}>{err}</p>}
    </div>
  );
}

// --- Build with AI -----------------------------------------------------------
function BuildWithAi({ forge, notify, onOpen }: { forge: Forge; notify: Notify; onOpen: (id: string) => void }) {
  const { creditsEnabled } = useConfig();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<unknown>(null);
  const [draftJson, setDraftJson] = useState<unknown>(null);
  const [changeRequest, setChangeRequest] = useState("");
  const [exDocs, setExDocs] = useState<ExDocSummary[]>([]);
  const [credits, setCredits] = useState<InsufficientCredits | null>(null);
  const managed = useManagedModel();

  const run = async (fn: () => Promise<{ draftJson?: unknown; session?: unknown }>, ok: string) => {
    setBusy(true);
    setCredits(null);
    try {
      const r = await fn();
      setDraftJson(r.draftJson ?? null);
      setSession(r.session ?? null);
      notify(ok);
    } catch (e) {
      const ic = asInsufficientCredits(e);
      if (ic) {
        setCredits(ic);
      } else {
        notify(errMsg(e), true);
      }
    } finally {
      setBusy(false);
    }
  };

  const generate = () => {
    const input: Record<string, unknown> = { userRequest: prompt };
    if (exDocs.length > 0) input.exampleDocuments = exDocs;
    // Ask the AI to include prepared prompts (parity with the desktop builder).
    input.requestedSections = ["basics", "skills", "preparedPrompts", "policies"];
    if (managed.modelForRequest) input.model = managed.modelForRequest;
    return run(
      () => forge.generateAgentKitDraftWithAi(input as never) as never,
      "Draft generated."
    );
  };

  return (
    <div className="form-layout">
      <div className="form-panel">
        <h2>Generate with AI</h2>
        <p className="form-copy">Uses your default AI provider if configured under Settings; otherwise managed prepaid credits. Generate a draft, optionally revise, then render into a kit.</p>
        {creditsEnabled && <CreditsPanel notify={notify} showDevGrant />}
        <Field label="Describe the kit you want">
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. A kit that reviews quarterly financial reports and flags anomalies." />
        </Field>

        <ExampleDocsPanel
          summaries={exDocs}
          onAdd={(s) => setExDocs((prev) => [...prev, s])}
          onRemove={(id) => setExDocs((prev) => prev.filter((d) => d.id !== id))}
        />

        <ManagedModelSelector
          managed={managed.managed}
          models={managed.models}
          model={managed.model}
          setModel={managed.setModel}
        />

        <Button style={{ marginTop: 12 }} disabled={!prompt.trim() || busy} loading={busy} onClick={() => void generate()}>
          {busy ? "Working…" : "Generate draft"}
        </Button>
        {credits && (
          <InsufficientCreditsBanner
            message={credits.message}
            requiredCents={credits.requiredCents}
            balanceCents={credits.balanceCents}
            currency={credits.currency}
            notify={notify}
          />
        )}
        {draftJson != null && (
          <>
            <div style={{ marginTop: 12 }}>
              <Field label="Revision request (optional)">
                <Input value={changeRequest} onChange={(e) => setChangeRequest(e.target.value)} placeholder="e.g. add a skill for variance analysis" />
              </Field>
            </div>
            <div className="button-row">
              <Button variant="secondary" disabled={!changeRequest.trim() || busy} onClick={() => void run(() => forge.reviseAgentKitDraftWithAi({ session, changeRequest, ...(managed.modelForRequest ? { model: managed.modelForRequest } : {}) } as never) as never, "Draft revised.").then(() => setChangeRequest(""))}>
                Revise
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const res = await forge.renderGeneratedAgentKitDraft({ draftJson, outputFolder: "", force: true });
                    notify("Kit created from draft.");
                    if (res.kitId) onOpen(res.kitId);
                  } catch (e) {
                    notify(errMsg(e), true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Render into a kit
              </Button>
            </div>
          </>
        )}
      </div>
      <div className="results-panel">
        <h2>Draft preview</h2>
        {draftJson == null ? (
          <p>Your generated draft will appear here. Review it before rendering into a kit.</p>
        ) : (
          <pre className="json-panel">{JSON.stringify(draftJson, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

// --- Guided Builder ----------------------------------------------------------
type GuidedStep = "basics" | "skills" | "policies" | "prompts" | "review";

type GuidedSkill = {
  id: string;
  name: string;
  description: string;
  triggers?: string;
  useWhen?: string;
  doNotUseWhen?: string;
};

type GuidedPolicy = {
  id: string;
  text: string;
};

// A prepared-prompt input, matching core's preparedPromptInputSchema. `choices`
// is edited as a newline string in the form and split on save.
type GuidedPromptInputType =
  | "short-text"
  | "long-text"
  | "choice"
  | "multi-choice"
  | "date"
  | "number"
  | "boolean";

type GuidedPromptInput = {
  id: string;
  label: string;
  type: GuidedPromptInputType;
  required: boolean;
  placeholder?: string;
  description?: string;
  choices?: string; // newline-separated in the form
  includeInPrompt: boolean;
};

type GuidedPromptDef = {
  id: string;
  name: string;
  description: string;
  template: string;
  inputs: GuidedPromptInput[];
  outputMode?: "text" | "markdown" | "document";
};

const PROMPT_INPUT_TYPES: GuidedPromptInputType[] = [
  "short-text",
  "long-text",
  "choice",
  "multi-choice",
  "date",
  "number",
  "boolean"
];

type GuidedForm = {
  kitId: string;
  name: string;
  description: string;
  domain: string;
  targetUsers: string;
  skills: GuidedSkill[];
  policies: GuidedPolicy[];
  prompts: GuidedPromptDef[];
};

const STEPS: { id: GuidedStep; label: string; badge?: string }[] = [
  { id: "basics", label: "Basics", badge: "Required" },
  { id: "skills", label: "Skills", badge: "Recommended" },
  { id: "policies", label: "Policies", badge: "Optional" },
  { id: "prompts", label: "Prompts", badge: "Optional" },
  { id: "review", label: "Review & Create" }
];

function GuidedBuilder({ forge, notify, onOpen }: { forge: Forge; notify: Notify; onOpen: (id: string) => void }) {
  const [step, setStep] = useState<GuidedStep>("basics");
  const [form, setForm] = useState<GuidedForm>({
    kitId: "",
    name: "",
    description: "",
    domain: "",
    targetUsers: "",
    skills: [],
    policies: [],
    prompts: []
  });
  const [busy, setBusy] = useState(false);
  const [newSkill, setNewSkill] = useState<GuidedSkill>({ id: "", name: "", description: "" });
  const [newPolicy, setNewPolicy] = useState<GuidedPolicy>({ id: "", text: "" });
  const [newPrompt, setNewPrompt] = useState<GuidedPromptDef>({ id: "", name: "", description: "", template: "", inputs: [] });
  const [newPromptInput, setNewPromptInput] = useState<GuidedPromptInput>({
    id: "",
    label: "",
    type: "short-text",
    required: false,
    includeInPrompt: true
  });

  const stepIdx = STEPS.findIndex((s) => s.id === step);

  const canCreate = form.kitId.trim() && form.name.trim() && form.description.trim();

  const addSkill = () => {
    if (!newSkill.id.trim() || !newSkill.name.trim()) return;
    setForm((f) => ({ ...f, skills: [...f.skills, { ...newSkill }] }));
    setNewSkill({ id: "", name: "", description: "" });
  };

  const addPolicy = () => {
    if (!newPolicy.text.trim()) return;
    const id = newPolicy.id.trim() || `policy-${Date.now()}`;
    setForm((f) => ({ ...f, policies: [...f.policies, { id, text: newPolicy.text }] }));
    setNewPolicy({ id: "", text: "" });
  };

  const addPromptInput = () => {
    const id = newPromptInput.id.trim() || newPromptInput.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!id || !newPromptInput.label.trim()) return;
    setNewPrompt((p) => ({ ...p, inputs: [...p.inputs, { ...newPromptInput, id }] }));
    setNewPromptInput({ id: "", label: "", type: "short-text", required: false, includeInPrompt: true });
  };

  const addPrompt = () => {
    if (!newPrompt.id.trim() || !newPrompt.name.trim()) return;
    setForm((f) => ({ ...f, prompts: [...f.prompts, { ...newPrompt }] }));
    setNewPrompt({ id: "", name: "", description: "", template: "", inputs: [] });
    setNewPromptInput({ id: "", label: "", type: "short-text", required: false, includeInPrompt: true });
  };

  const buildDraft = () => {
    const skills = form.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      triggers: s.triggers ? [s.triggers] : undefined,
      useWhen: s.useWhen || undefined,
      doNotUseWhen: s.doNotUseWhen || undefined
    }));
    const preparedPrompts = form.prompts.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      template: p.template || `# ${p.name}\n\n{{context}}`,
      inputs: p.inputs.map((inp) => {
        const choices =
          (inp.type === "choice" || inp.type === "multi-choice") && inp.choices
            ? inp.choices.split("\n").map((c) => c.trim()).filter(Boolean)
            : undefined;
        return {
          id: inp.id,
          label: inp.label,
          type: inp.type,
          required: inp.required,
          includeInPrompt: inp.includeInPrompt,
          ...(inp.placeholder?.trim() ? { placeholder: inp.placeholder.trim() } : {}),
          ...(inp.description?.trim() ? { description: inp.description.trim() } : {}),
          ...(choices && choices.length ? { choices } : {})
        };
      }),
      ...(p.outputMode ? { outputMode: p.outputMode } : {})
    }));
    const policies =
      form.policies.length > 0
        ? form.policies.map((p) => ({ id: p.id, text: p.text }))
        : undefined;
    return {
      manifest: {
        id: form.kitId.trim(),
        name: form.name.trim(),
        version: "1",
        schemaVersion: "0.1",
        description: form.description.trim(),
        domain: form.domain.trim() || undefined,
        targetUsers: form.targetUsers.trim() || undefined
      },
      skills,
      policies,
      preparedPrompts: preparedPrompts.length ? preparedPrompts : undefined,
      files: {}
    };
  };

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      const draft = buildDraft();
      const res = await forge.renderGeneratedAgentKitDraft({ draftJson: draft, outputFolder: "", force: true });
      notify("Kit created from guided builder.");
      if (res.kitId) onOpen(res.kitId);
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-layout">
      <div className="form-panel">
        {/* Step indicator */}
        <div className="step-indicator" style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className={`segment-button ${s.id === step ? "active" : ""}`}
              onClick={() => setStep(s.id)}
              style={{ fontSize: "0.82em" }}
            >
              {i + 1}. {s.label}
              {s.badge && <span className="source-badge" style={{ marginLeft: 4, fontSize: "0.75em" }}>{s.badge}</span>}
            </button>
          ))}
        </div>

        {step === "basics" && (
          <>
            <h2>Basic information</h2>
            <p className="form-copy">Define the core identity of your Agent Kit.</p>
            <Field label={<>Kit ID (slug) <span style={{ color: "var(--color-error)" }}>*</span></>}><Input value={form.kitId} onChange={(e) => setForm((f) => ({ ...f, kitId: e.target.value }))} placeholder="my-kit" /></Field>
            <Field label={<>Name <span style={{ color: "var(--color-error)" }}>*</span></>}><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="My Kit" /></Field>
            <Field label={<>Description <span style={{ color: "var(--color-error)" }}>*</span></>}><Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></Field>
            <Field label="Domain (optional)"><Input value={form.domain} onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))} placeholder="e.g. finance, legal, healthcare" /></Field>
            <Field label="Target users (optional)"><Input value={form.targetUsers} onChange={(e) => setForm((f) => ({ ...f, targetUsers: e.target.value }))} placeholder="e.g. financial analysts, legal teams" /></Field>
            <div className="button-row" style={{ marginTop: 12 }}>
              <Button disabled={!form.kitId.trim() || !form.name.trim() || !form.description.trim()} onClick={() => setStep("skills")}>Next: Skills →</Button>
            </div>
          </>
        )}

        {step === "skills" && (
          <>
            <h2>Skills ({form.skills.length} defined)</h2>
            <p className="form-copy">Skills are discrete capabilities your kit provides. Each skill has a name, description, and optional triggers. At least one skill is recommended.</p>
            {form.skills.map((s, i) => (
              <div key={s.id} className="provider-card" style={{ marginBottom: 8 }}>
                <strong>{s.name}</strong> <span className="inline-code">{s.id}</span>
                <p className="form-copy" style={{ margin: "2px 0" }}>{s.description}</p>
                {s.triggers && <p className="form-copy" style={{ margin: "2px 0", fontSize: "0.85em" }}>Triggers: {s.triggers}</p>}
                {s.useWhen && <p className="form-copy" style={{ margin: "2px 0", fontSize: "0.85em" }}>Use when: {s.useWhen}</p>}
                {s.doNotUseWhen && <p className="form-copy" style={{ margin: "2px 0", fontSize: "0.85em" }}>Do not use when: {s.doNotUseWhen}</p>}
                <Button variant="danger" size="sm" style={{ fontSize: "0.8em", padding: "2px 10px" }} onClick={() => setForm((f) => ({ ...f, skills: f.skills.filter((_, j) => j !== i) }))}>Remove</Button>
              </div>
            ))}
            <Field label="Skill ID"><Input value={newSkill.id} onChange={(e) => setNewSkill((s) => ({ ...s, id: e.target.value }))} placeholder="analyze-report" /></Field>
            <Field label="Skill name"><Input value={newSkill.name} onChange={(e) => setNewSkill((s) => ({ ...s, name: e.target.value }))} placeholder="Analyze Report" /></Field>
            <Field label="Description"><Textarea value={newSkill.description} onChange={(e) => setNewSkill((s) => ({ ...s, description: e.target.value }))} style={{ minHeight: 64 }} /></Field>
            <Field label="Triggers (optional) — natural-language phrases that invoke this skill"><Input value={newSkill.triggers ?? ""} onChange={(e) => setNewSkill((s) => ({ ...s, triggers: e.target.value }))} placeholder="when user asks to analyze…" /></Field>
            <Field label="Use when (optional)"><Input value={newSkill.useWhen ?? ""} onChange={(e) => setNewSkill((s) => ({ ...s, useWhen: e.target.value }))} placeholder="user provides a report document" /></Field>
            <Field label="Do not use when (optional)"><Input value={newSkill.doNotUseWhen ?? ""} onChange={(e) => setNewSkill((s) => ({ ...s, doNotUseWhen: e.target.value }))} placeholder="no document is provided" /></Field>
            <div className="button-row">
              <Button variant="secondary" disabled={!newSkill.id.trim() || !newSkill.name.trim()} onClick={addSkill}>+ Add skill</Button>
              <Button onClick={() => setStep("policies")}>Next: Policies →</Button>
            </div>
          </>
        )}

        {step === "policies" && (
          <>
            <h2>Policies ({form.policies.length} defined)</h2>
            <p className="form-copy">Policies are guardrails and rules the kit enforces — what it should always or never do. Each policy is a plain-text statement.</p>
            {form.policies.map((p, i) => (
              <div key={p.id} className="provider-card" style={{ marginBottom: 8 }}>
                <p className="form-copy" style={{ margin: "2px 0" }}>{p.text}</p>
                <Button variant="danger" size="sm" style={{ fontSize: "0.8em", padding: "2px 10px" }} onClick={() => setForm((f) => ({ ...f, policies: f.policies.filter((_, j) => j !== i) }))}>Remove</Button>
              </div>
            ))}
            <Field label="Policy text"><Textarea value={newPolicy.text} onChange={(e) => setNewPolicy((p) => ({ ...p, text: e.target.value }))} style={{ minHeight: 64 }} placeholder="Always cite sources when summarizing documents." /></Field>
            <div className="button-row">
              <Button variant="secondary" disabled={!newPolicy.text.trim()} onClick={addPolicy}>+ Add policy</Button>
              <Button onClick={() => setStep("prompts")}>Next: Prompts →</Button>
            </div>
          </>
        )}

        {step === "prompts" && (
          <>
            <h2>Prepared prompts ({form.prompts.length} defined)</h2>
            <p className="form-copy">Prepared prompts are templated workflows users can run from the Use section. Use {"{{variable}}"} syntax for inputs. Optional but recommended.</p>
            {form.prompts.map((p, i) => (
              <div key={p.id} className="provider-card" style={{ marginBottom: 8 }}>
                <strong>{p.name}</strong> <span className="inline-code">{p.id}</span>
                <p className="form-copy" style={{ margin: "2px 0" }}>{p.description}</p>
                {p.inputs.length > 0 && (
                  <p className="form-copy" style={{ margin: "2px 0", fontSize: "0.85em" }}>
                    Inputs: {p.inputs.map((inp) => `${inp.label}${inp.required ? "*" : ""} (${inp.type})`).join(", ")}
                  </p>
                )}
                <Button variant="danger" size="sm" style={{ fontSize: "0.8em", padding: "2px 10px" }} onClick={() => setForm((f) => ({ ...f, prompts: f.prompts.filter((_, j) => j !== i) }))}>Remove</Button>
              </div>
            ))}
            <Field label="Prompt ID"><Input value={newPrompt.id} onChange={(e) => setNewPrompt((p) => ({ ...p, id: e.target.value }))} placeholder="run-analysis" /></Field>
            <Field label="Prompt name"><Input value={newPrompt.name} onChange={(e) => setNewPrompt((p) => ({ ...p, name: e.target.value }))} placeholder="Run Analysis" /></Field>
            <Field label="Description"><Input value={newPrompt.description} onChange={(e) => setNewPrompt((p) => ({ ...p, description: e.target.value }))} /></Field>
            <Field label={<>Template (use {"{{variable}}"} for inputs)</>}><Textarea value={newPrompt.template} onChange={(e) => setNewPrompt((p) => ({ ...p, template: e.target.value }))} style={{ minHeight: 80, fontFamily: "var(--mono, monospace)" }} placeholder={"Analyze the following report:\n\n{{report}}\n\nFocus on: {{focus_area}}"} /></Field>
            <Field label="Output mode (optional)">
              <Select value={newPrompt.outputMode ?? ""} onChange={(e) => setNewPrompt((p) => ({ ...p, outputMode: (e.target.value || undefined) as GuidedPromptDef["outputMode"] }))}>
                <option value="">default</option>
                <option value="text">text</option>
                <option value="markdown">markdown</option>
                <option value="document">document</option>
              </Select>
            </Field>

            {/* Typed inputs for this prompt (parity with desktop prepared prompts) */}
            <div className="provider-card" style={{ marginTop: 4, marginBottom: 8 }}>
              <p style={{ fontWeight: 600, margin: "0 0 6px", fontSize: "0.9em" }}>Inputs for this prompt ({newPrompt.inputs.length})</p>
              <p className="form-copy" style={{ marginTop: 0, fontSize: "0.84em" }}>
                Each input becomes a {"{{field}}"} the user fills in when running the prompt. The input ID should match the {"{{variable}}"} name in your template.
              </p>
              {newPrompt.inputs.map((inp, j) => (
                <div key={inp.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span className="inline-code" style={{ fontSize: "0.82em" }}>{inp.id}</span>
                  <span style={{ flex: 1, fontSize: "0.85em" }}>{inp.label} <span style={{ color: "var(--color-text-secondary)" }}>({inp.type}{inp.required ? ", required" : ""}{inp.includeInPrompt ? "" : ", collected only"})</span></span>
                  <Button variant="danger" size="sm" style={{ fontSize: "0.76em", padding: "2px 8px" }} onClick={() => setNewPrompt((p) => ({ ...p, inputs: p.inputs.filter((_, k) => k !== j) }))}>Remove</Button>
                </div>
              ))}
              <div style={{ marginBottom: 6 }}><Field label={<span style={{ fontSize: "0.85em" }}>Input label</span>}><Input value={newPromptInput.label} onChange={(e) => setNewPromptInput((s) => ({ ...s, label: e.target.value }))} placeholder="Report text" /></Field></div>
              <div style={{ marginBottom: 6 }}><Field label={<span style={{ fontSize: "0.85em" }}>Input ID (matches {"{{variable}}"}; auto from label if blank)</span>}><Input value={newPromptInput.id} onChange={(e) => setNewPromptInput((s) => ({ ...s, id: e.target.value }))} placeholder="report" /></Field></div>
              <div style={{ marginBottom: 6 }}>
                <Field label={<span style={{ fontSize: "0.85em" }}>Type</span>}>
                  <Select value={newPromptInput.type} onChange={(e) => setNewPromptInput((s) => ({ ...s, type: e.target.value as GuidedPromptInputType }))}>
                    {PROMPT_INPUT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                </Field>
              </div>
              {(newPromptInput.type === "choice" || newPromptInput.type === "multi-choice") && (
                <div style={{ marginBottom: 6 }}><Field label={<span style={{ fontSize: "0.85em" }}>Choices (one per line)</span>}><Textarea value={newPromptInput.choices ?? ""} onChange={(e) => setNewPromptInput((s) => ({ ...s, choices: e.target.value }))} style={{ minHeight: 56 }} placeholder={"low\nmedium\nhigh"} /></Field></div>
              )}
              <div style={{ marginBottom: 6 }}><Field label={<span style={{ fontSize: "0.85em" }}>Placeholder / help (optional)</span>}><Input value={newPromptInput.placeholder ?? ""} onChange={(e) => setNewPromptInput((s) => ({ ...s, placeholder: e.target.value }))} /></Field></div>
              <div style={{ display: "flex", gap: 16, marginBottom: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: "0.85em" }}>
                  <input type="checkbox" checked={newPromptInput.required} onChange={(e) => setNewPromptInput((s) => ({ ...s, required: e.target.checked }))} /> Required
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: "0.85em" }}>
                  <input type="checkbox" checked={newPromptInput.includeInPrompt} onChange={(e) => setNewPromptInput((s) => ({ ...s, includeInPrompt: e.target.checked }))} /> Include in prompt
                </label>
              </div>
              <Button variant="secondary" style={{ fontSize: "0.82em" }} disabled={!newPromptInput.label.trim()} onClick={addPromptInput}>+ Add input</Button>
            </div>

            <div className="button-row">
              <Button variant="secondary" disabled={!newPrompt.id.trim() || !newPrompt.name.trim()} onClick={addPrompt}>+ Add prompt</Button>
              <Button onClick={() => setStep("review")}>Next: Review →</Button>
            </div>
          </>
        )}

        {step === "review" && (
          <>
            <h2>Review &amp; create</h2>
            <div className="results-panel" style={{ padding: "12px 16px", marginBottom: 12 }}>
              <p><strong>ID:</strong> <span className="inline-code">{form.kitId}</span></p>
              <p><strong>Name:</strong> {form.name}</p>
              <p><strong>Description:</strong> {form.description}</p>
              {form.domain && <p><strong>Domain:</strong> {form.domain}</p>}
              <p><strong>Skills:</strong> {form.skills.length} defined</p>
              <p><strong>Policies:</strong> {form.policies.length} defined</p>
              <p><strong>Prompts:</strong> {form.prompts.length} defined</p>
            </div>
            {!canCreate && <p className="inline-warning">Fill in Kit ID, Name, and Description to create.</p>}
            <div className="button-row">
              <Button variant="secondary" onClick={() => setStep("basics")}>← Back</Button>
              <Button disabled={!canCreate || busy} loading={busy} onClick={() => void create()}>
                {busy ? "Creating…" : "Create kit"}
              </Button>
            </div>
          </>
        )}

        {stepIdx < STEPS.length - 1 && step !== "basics" && step !== "skills" && step !== "policies" && step !== "prompts" && step !== "review" && (
          <div className="button-row" style={{ marginTop: 12 }}>
            <Button variant="secondary" onClick={() => setStep(STEPS[Math.max(0, stepIdx - 1)].id)}>← Back</Button>
          </div>
        )}
      </div>

      <div className="results-panel">
        <h2>Preview</h2>
        <pre className="json-panel" style={{ fontSize: "0.78em" }}>{JSON.stringify(buildDraft(), null, 2)}</pre>
      </div>
    </div>
  );
}

// --- Edit with AI ------------------------------------------------------------
function EditWithAi({
  forge,
  notify,
  kits,
  onOpen
}: {
  forge: Forge;
  notify: Notify;
  kits: MyKitEntry[];
  onOpen: (id: string) => void;
}) {
  const [kitId, setKitId] = useState("");
  const [draft, setDraft] = useState<unknown>(null);
  const [session, setSession] = useState<unknown>(null);
  const [changeRequest, setChangeRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const managed = useManagedModel();

  const loadDraft = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/kits/${encodeURIComponent(id)}/draft`, { credentials: "include" }).then((r) => r.json());
      setDraft(res.draft ?? null);
      setSession(null);
      notify("Kit loaded as draft.");
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  const revise = async () => {
    if (!changeRequest.trim() || !draft) return;
    setBusy(true);
    try {
      const r = await forge.reviseAgentKitDraftWithAi({ session, changeRequest, ...(managed.modelForRequest ? { model: managed.modelForRequest } : {}) } as never) as { draftJson?: unknown; session?: unknown };
      setDraft(r.draftJson ?? draft);
      setSession(r.session ?? session);
      setChangeRequest("");
      notify("Draft revised.");
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  const render = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const res = await forge.renderGeneratedAgentKitDraft({ draftJson: draft, outputFolder: "", force: true });
      notify("Kit updated from revised draft.");
      if (res.kitId) onOpen(res.kitId);
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-layout">
      <div className="form-panel">
        <h2>Edit existing kit with AI</h2>
        <p className="form-copy">Load an owned kit as a draft, request AI revisions, then render the updated kit. The original kit is not modified until you render.</p>
        <Field label="Kit to edit">
          <Select value={kitId} onChange={(e) => setKitId(e.target.value)}>
            <option value="">Select a kit…</option>
            {kits.map((k) => (
              <option key={k.kitId} value={k.kitId}>{k.name ?? k.kitId}</option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" disabled={!kitId || busy} loading={busy && !draft} onClick={() => void loadDraft(kitId)}>
          {busy && !draft ? "Loading…" : "Load as draft"}
        </Button>
        {draft != null && (
          <>
            <ManagedModelSelector
              managed={managed.managed}
              models={managed.models}
              model={managed.model}
              setModel={managed.setModel}
            />
            <div style={{ marginTop: 12 }}>
              <Field label="What should change?">
                <Textarea value={changeRequest} onChange={(e) => setChangeRequest(e.target.value)} placeholder="e.g. add a skill for executive summary generation, improve the description" />
              </Field>
            </div>
            <div className="button-row">
              <Button variant="secondary" disabled={!changeRequest.trim() || busy} loading={busy} onClick={() => void revise()}>
                {busy ? "Revising…" : "Revise with AI"}
              </Button>
              <Button disabled={busy} onClick={() => void render()}>
                Render updated kit
              </Button>
            </div>
          </>
        )}
      </div>
      <div className="results-panel">
        <h2>Draft</h2>
        {draft == null ? (
          <p>Select a kit and load it as a draft. The draft JSON will appear here for review before rendering.</p>
        ) : (
          <pre className="json-panel" style={{ fontSize: "0.78em" }}>{JSON.stringify(draft, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

// --- Build From Template -----------------------------------------------------
function BuildFromTemplate({ forge, notify, onOpen }: { forge: Forge; notify: Notify; onOpen: (id: string) => void }) {
  const [template, setTemplate] = useState("blank");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = id.trim() && name.trim() && description.trim();

  return (
    <div className="form-layout">
      <div className="form-panel">
        <h2>Create from template</h2>
        <p className="form-copy">Scaffold a new Agent Kit from a starter template, then open it in the editor.</p>
        <Field label="Template">
          <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="blank">blank</option>
            <option value="financial-review">financial-review</option>
          </Select>
        </Field>
        <Field label="Kit id (slug)">
          <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="my-kit" />
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Kit" />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Button
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await forge.createAgentKitFromTemplate({ template, id: id.trim(), name: name.trim(), description: description.trim() } as never);
              notify("Kit created.");
              if (res.kitId) onOpen(res.kitId);
            } catch (e) {
              notify(errMsg(e), true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Creating…" : "Create kit"}
        </Button>
      </div>
      <div className="results-panel">
        <h2>What you get</h2>
        <p>A valid Agent Kit scaffold with <span className="inline-code">agentkit.yaml</span>, <span className="inline-code">AGENTKIT.md</span>, <span className="inline-code">START_HERE.md</span>, and a starter skill. Edit the files, validate against a profile, then package or export.</p>
      </div>
    </div>
  );
}

// --- Render Draft JSON -------------------------------------------------------
function RenderDraftJson({ forge, notify, onOpen }: { forge: Forge; notify: Notify; onOpen: (id: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="form-layout">
      <div className="form-panel">
        <h2>Render a draft JSON</h2>
        <p className="form-copy">Paste an Agent Kit draft (the JSON the AI builder produces) to render it into a new kit in your library.</p>
        <Field label="Draft JSON">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 220, fontFamily: "var(--mono, monospace)" }} placeholder='{ "manifest": { ... }, "files": { ... } }' />
        </Field>
        <Button
          disabled={!text.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const draftJson = JSON.parse(text);
              const res = await forge.renderGeneratedAgentKitDraft({ draftJson, outputFolder: "", force: true });
              notify("Kit created from draft.");
              if (res.kitId) onOpen(res.kitId);
            } catch (e) {
              notify(errMsg(e), true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Rendering…" : "Render into a kit"}
        </Button>
      </div>
      <div className="results-panel">
        <h2>Draft format</h2>
        <p>The draft is the structured JSON describing the kit manifest and files. Use the AI builder to generate one, or paste a draft you exported earlier.</p>
      </div>
    </div>
  );
}
