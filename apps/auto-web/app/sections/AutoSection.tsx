"use client";

// AgentKitAuto — on-demand, fire-and-forget autonomous runs (Phase A).
//
// Three things, minimal but functional:
//   1. Create a STANDING APPROVAL for one of your kits (tool allowlist + max
//      budget). The allowlist is your consent — Auto runs the kit with no per-step
//      confirm. The Phase-A sandbox supports ONLY file tools (read_file / list_dir
//      / write_file); there is NO autonomous shell, so run_command is intentionally
//      not offered here (auto-core hard-rejects it anyway).
//   2. START A RUN: pick a kit you have an approval for, enter the task input, and
//      set THIS run's budget (required; must be <= the approval ceiling — the
//      server enforces it and returns 403 if exceeded).
//   3. RUN HISTORY + detail: status, final output, produced-file manifest, audit
//      log, and a kill-switch cancel button. Polls the detail while a run is active.
//
// All HTTP is the cookie path (/api/auto/*) via fetch with credentials — this is
// the browser UI; the bearer path (/api/forge/auto/*) is for desktop/CLI clients.
import { useCallback, useEffect, useState } from "react";
import { Badge, BRAND_ACCENTS, Button, Card, Field, Input, Pill, Select, Textarea, brandVars } from "@agentkitforge/ui";
import type { AutoSectionId } from "./section-ids";
import { recurrenceToCron, type RecurrenceKind, type DayOfWeek } from "./recurrence";
import { autoRoutes } from "@agentkitforge/contracts";
import type { CatalogEntry, MyKitEntry, Notify, PublicProvider } from "./shared";
import { errMsg } from "./shared";
import { ClientTime } from "./ClientTime";
// Kit selectors address a kit by an opaque string value so a single <Select> can
// offer BOTH local kits and entitled Market kits. The market-aware KitRef +
// selection/deep-link helpers live in ./market-kit-ref (pure + unit-tested).
import {
  MARKET_PREFIX,
  isMarketSelection,
  marketSelectionValue,
  parseKitSelection,
  parseMarketDeepLink,
  creditsDisclosureKind,
  type EntitledKit
} from "./market-kit-ref";

// AgentKitAuto accent. Wrapping the section in brandVars(AUTO_GREEN) re-themes
// every framework primitive (buttons, badges, focus rings, active nav) inside
// it to Auto green, while the rest of the app stays Forge indigo.
const AUTO_GREEN = BRAND_ACCENTS.auto.accent;
const AUTO_GREEN_STRONG = BRAND_ACCENTS.auto.strong;

// Phase-A sandbox tools the user can authorize. NO run_command (no autonomous shell).
const SANDBOX_TOOLS = ["read_file", "list_dir", "write_file"] as const;
// Phase C: the network-egress tool. Available to a run only when the approval's
// networkPolicy is an allowlist AND this tool is in the allowlist.
const HTTP_FETCH_TOOL = "http_fetch";

// Auto v2 billing snapshot returned by GET /api/auto/billing (mirrors the
// server's AutoBillingSummary). metered:false on a FREE self-host (unmetered).
type AutoBillingSummary = {
  metered: boolean;
  balanceCents: number;
  freeMinutesRemaining: number;
  freeMinutesPerMonth: number;
  invocationFeeCents: number;
  activeMinuteRateCents: number;
};

// A managed (in-house, prepaid-credit) model offered by GET /api/managed/models —
// Claude + GPT entries the create forms let the user pick per-run/schedule/webhook.
type ManagedModel = { id: string; label: string; tier: string; provider: "anthropic" | "openai" };

const PROVIDER_GROUP_LABEL: Record<ManagedModel["provider"], string> = {
  anthropic: "Claude",
  openai: "OpenAI (GPT)"
};

// Groups models by provider, preserving each group's first-seen order, for the
// <optgroup> split in the model selector.
function groupModelsByProvider(models: ManagedModel[]): [ManagedModel["provider"], ManagedModel[]][] {
  const groups = new Map<ManagedModel["provider"], ManagedModel[]>();
  for (const m of models) {
    const list = groups.get(m.provider);
    if (list) list.push(m);
    else groups.set(m.provider, [m]);
  }
  return [...groups.entries()];
}

// Phase C: network egress policy (deny_all default, or an allowlist of hosts).
type NetworkPolicy = { mode: "deny_all" } | { mode: "allowlist"; hosts: string[] };

type Approval = {
  id: string;
  kitRef: { source: string; localKitId?: string; marketKitId?: string; slug?: string };
  toolAllowlist: string[];
  maxBudgetCents: number;
  networkPolicy: NetworkPolicy | string;
  createdAt: string;
  revokedAt: string | null;
};

type Webhook = {
  id: string;
  kitRef: { source: string; localKitId?: string; marketKitId?: string; slug?: string };
  approvalId: string;
  budgetCents: number;
  model: string;
  enabled: boolean;
  createdAt: string;
  lastFiredAt: string | null;
  lastRunId: string | null;
  lastError: string | null;
  fireCount: number;
  ingestUrl: string;
};

// The create-webhook response additionally carries the one-time plaintext secret.
type CreatedWebhook = Webhook & { secret: string };

type AuditEntry = { tool: string; argsSummary: string; outcome: string; ts: string; detail?: string };
type RunFile = { path: string; sizeBytes: number };
// Persisted-output manifest entry (durable OutputStore copy; downloadable via
// /api/auto/runs/[id]/outputs/[...path] while unexpired).
type RunOutputFile = { path: string; sizeBytes: number; storeKey?: string; expiresAt?: string };
type Run = {
  id: string;
  kitRef: { source: string; localKitId?: string; marketKitId?: string; slug?: string };
  status: string;
  input: { prompt: string };
  budgetCents: number;
  spentCents: number;
  model: string;
  createdAt: string;
  finishedAt?: string;
  error?: string;
  result?: { output: string; files: RunFile[] };
  outputFiles?: RunOutputFile[];
  auditLog?: AuditEntry[];
};

/** Download URL for one persisted run output (path segments URL-encoded). */
function runOutputHref(runId: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/api/auto/runs/${encodeURIComponent(runId)}/outputs/${encoded}`;
}

type Schedule = {
  id: string;
  kitRef: { source: string; localKitId?: string; marketKitId?: string; slug?: string };
  cron: string;
  timezone: string;
  input: { prompt: string };
  budgetCents: number;
  model: string;
  approvalId: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
  nextRunAt: string;
  lastError: string | null;
};

const ACTIVE = new Set(["queued", "running"]);

function centsToUsd(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}


/** The browser's IANA timezone, used as the schedule default. */
function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Phase D: opt-in result delivery. A run/schedule/webhook can OPTIONALLY notify
// on completion via email and/or a signed webhook. Absent → no delivery.
type DeliveryWebhook = { url: string; secret?: string };
type DeliveryConfig = { email?: string[]; webhook?: DeliveryWebhook };

// Per-form delivery field state (raw text inputs; assembled into a DeliveryConfig
// just before the create request).
type DeliveryFields = { emails: string; webhookUrl: string; webhookSecret: string };
const EMPTY_DELIVERY: DeliveryFields = { emails: "", webhookUrl: "", webhookSecret: "" };

/**
 * Assemble a DeliveryConfig from the raw form fields, or undefined when nothing
 * was entered (delivery stays off). Emails are comma/whitespace/newline split.
 * The webhook channel is included only when a URL is present (an optional secret
 * rides along). The SERVER re-validates (https-only webhook, basic email format)
 * and rejects bad input with a 400 — this is a convenience pass, not the gate.
 */
function buildDeliveryConfig(f: DeliveryFields): DeliveryConfig | undefined {
  const email = f.emails
    .split(/[\s,]+/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  const url = f.webhookUrl.trim();
  const secret = f.webhookSecret.trim();
  const config: DeliveryConfig = {};
  if (email.length > 0) config.email = email;
  if (url.length > 0) config.webhook = { url, ...(secret ? { secret } : {}) };
  return config.email || config.webhook ? config : undefined;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

/**
 * Phase D — the opt-in "Deliver result" sub-form, reused by Start-a-run,
 * Schedules, and Webhooks. Optional email recipients (comma-separated) + an
 * optional signed-webhook destination (URL + optional secret). Empty → no
 * delivery. Controlled by a DeliveryFields value the parent owns per form.
 */
function DeliverySection({
  value,
  onChange,
  scopeNoun
}: {
  value: DeliveryFields;
  onChange: (next: DeliveryFields) => void;
  scopeNoun: string;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <h4 style={{ margin: "8px 0 2px" }}>Deliver result (optional)</h4>
      <p className="form-copy" style={{ marginTop: 0 }}>
        Notify on completion. Leave blank for no delivery. We&apos;ll send the {scopeNoun}&apos;s final
        result to the email(s) and/or webhook below when it finishes.
      </p>
      <Field label="Email recipients (comma-separated)">
        <Input
          type="text"
          value={value.emails}
          onChange={(e) => onChange({ ...value, emails: e.target.value })}
          placeholder="you@example.com, ops@example.com"
        />
      </Field>
      <Field label="Webhook URL (https only)">
        <Input
          type="url"
          value={value.webhookUrl}
          onChange={(e) => onChange({ ...value, webhookUrl: e.target.value })}
          placeholder="https://example.com/auto-result"
        />
      </Field>
      <Field label="Webhook signing secret (optional)">
        <Input
          type="text"
          value={value.webhookSecret}
          onChange={(e) => onChange({ ...value, webhookSecret: e.target.value })}
          placeholder="HMAC-SHA256 secret"
        />
      </Field>
    </div>
  );
}

export function AutoSection({
  section,
  kits,
  notify,
  marketUrl,
  marketEnabled,
  allowedProviders
}: {
  /** Active dashboard tab (owned by AutoApp's sidebar nav). Each value renders
   *  one full-width pane; sections not matching `section` are not rendered. */
  section: AutoSectionId;
  kits: MyKitEntry[];
  notify: Notify;
  marketUrl?: string;
  marketEnabled?: boolean;
  /** Provider-lock: the AI provider types this deployment permits, or null when
   *  unrestricted. The add/update form hides disallowed types; when EVERY type
   *  is excluded the whole BYO provider manager is hidden (the server also
   *  rejects a disallowed save regardless of what the UI shows). */
  allowedProviders?: string[] | null;
}) {
  // Provider-lock: a type is allowed when unrestricted (null) or in the list.
  const isAllowed = useCallback(
    (type: string) => allowedProviders == null || allowedProviders.includes(type),
    [allowedProviders]
  );
  // When the deployment restricts providers to an EMPTY set, BYO is fully
  // disabled (runs use managed credits only) — hide the provider manager.
  const byoEnabled = allowedProviders == null || allowedProviders.length > 0;
  const [approvals, setApprovals] = useState<Approval[]>([]);
  // Protected (paid + non-downloadable) Market kits the user has purchased. Only
  // populated when Market is enabled; empty on a free open-core self-host (the
  // whole picker surface then stays hidden — fails closed). Browser-safe shape.
  const [entitled, setEntitled] = useState<EntitledKit[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<Run | null>(null);

  // Approval form state.
  const [apprKitId, setApprKitId] = useState("");
  const [apprTools, setApprTools] = useState<string[]>(["read_file", "list_dir"]);
  const [apprBusy, setApprBusy] = useState(false);
  // Phase C: network egress policy on the approval form.
  const [apprNetMode, setApprNetMode] = useState<"deny_all" | "allowlist">("deny_all");
  const [apprNetHosts, setApprNetHosts] = useState(""); // newline/comma-separated host patterns
  const [apprHttpFetch, setApprHttpFetch] = useState(false);

  // Inference-mode preference (Phase 2) — managed vs BYO routing.
  const [byoMode, setByoMode] = useState<"auto" | "managed" | "byo">("auto");

  // BYO provider manager: a user can configure a provider of ANY of the 5 types
  // (the run-resolution path reads their default provider, any type). Mirrors the
  // forge-web Settings AI-provider section; writes to the same UserSettingsStore.
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState<string | undefined>(undefined);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [provBusy, setProvBusy] = useState(false);
  // Add/update form state.
  const [provType, setProvType] = useState("anthropic");
  const [provName, setProvName] = useState("");
  const [provBaseUrl, setProvBaseUrl] = useState("");
  const [provModel, setProvModel] = useState("");
  const [provApiKey, setProvApiKey] = useState("");

  // "My own key" is selectable once ANY configured provider has a key on file.
  const byoHasKey = providers.some((p) => p.hasApiKey);

  // Auto v2 billing snapshot (balance + remaining free active-minutes). Null
  // until loaded; metered:false on a FREE self-host (then the credits affordance
  // is hidden — runs are unmetered). Applies to BYO users too: a BYO run still
  // incurs the v2 run fee (invocation + active-minutes), so they see balance +
  // free minutes + the buy-credits link the same as managed users.
  const [billing, setBilling] = useState<AutoBillingSummary | null>(null);

  // Managed model catalog (Claude + GPT) for the create forms below. Empty (or
  // `disabled`) on a BYO-only self-host — the pickers stay hidden in that case.
  const [managedModels, setManagedModels] = useState<ManagedModel[]>([]);
  const [managedDefaultModel, setManagedDefaultModel] = useState("");

  // Run form state.
  const [runKitId, setRunKitId] = useState("");
  const [runPrompt, setRunPrompt] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  // Phase 2: per-run inference-mode override ("" = use account preference).
  const [runInferenceMode, setRunInferenceMode] = useState<"" | "managed" | "byo">("");
  // Managed model override for this run ("" = server-resolved default).
  const [runModel, setRunModel] = useState("");
  // Phase C: user-provided input files staged via presigned upload then attached
  // to the run as a manifest. Selected files are uploaded on run start.
  const [runInputFiles, setRunInputFiles] = useState<File[]>([]);
  // Phase D: opt-in result-delivery fields for the run.
  const [runDelivery, setRunDelivery] = useState<DeliveryFields>(EMPTY_DELIVERY);

  // Webhook state (Phase C).
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [whKitId, setWhKitId] = useState("");
  const [whBusy, setWhBusy] = useState(false);
  // Managed model override for webhook-fired runs ("" = server-resolved default).
  const [whModel, setWhModel] = useState("");
  // The one-time plaintext secret + ingest URL, shown ONCE after creation.
  const [whSecret, setWhSecret] = useState<{ secret: string; ingestUrl: string } | null>(null);
  // Phase D: opt-in result-delivery fields for webhook-fired runs.
  const [whDelivery, setWhDelivery] = useState<DeliveryFields>(EMPTY_DELIVERY);

  // Schedule state (Phase B).
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [schedKitId, setSchedKitId] = useState("");
  // Friendly recurrence picker (primary). "advanced" reveals the raw cron field.
  const [schedRepeat, setSchedRepeat] = useState<RecurrenceKind>("daily");
  const [schedTime, setSchedTime] = useState("09:00"); // HH:MM for daily/weekly/monthly
  const [schedDow, setSchedDow] = useState<DayOfWeek>(1); // weekly: 0=Sun … 6=Sat
  const [schedDom, setSchedDom] = useState(1); // monthly: 1–31
  const [schedCron, setSchedCron] = useState("0 9 * * *"); // raw cron (advanced mode)
  const [schedTz, setSchedTz] = useState(localTimezone());
  const [schedPrompt, setSchedPrompt] = useState("");
  const [schedBusy, setSchedBusy] = useState(false);
  // Managed model override for scheduled runs ("" = server-resolved default).
  const [schedModel, setSchedModel] = useState("");

  // Per-run budget settings (Phase 2.5): the per-run budget is no longer entered
  // on each form — it is resolved server-side (org override → user default → 50¢).
  // The Settings tab edits the user's own default; the forms show the resolved
  // effective value read-only. `runBudget` holds the latest snapshot from
  // /api/auto/run-budget; `runBudgetDraftUsd` is the Settings input.
  const [runBudget, setRunBudget] = useState<{
    userDefaultCents: number | null;
    effectiveCents: number;
    systemFallbackCents: number;
  } | null>(null);
  const [runBudgetDraftUsd, setRunBudgetDraftUsd] = useState("");
  const [runBudgetBusy, setRunBudgetBusy] = useState(false);
  // Phase D: opt-in result-delivery fields copied onto every scheduled run.
  const [schedDelivery, setSchedDelivery] = useState<DeliveryFields>(EMPTY_DELIVERY);

  const loadApprovals = useCallback(async () => {
    try {
      const { approvals } = await jsonFetch<{ approvals: Approval[] }>(autoRoutes.approvals());
      setApprovals(approvals.filter((a) => a.revokedAt === null));
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify]);

  const loadRuns = useCallback(async () => {
    try {
      const { runs } = await jsonFetch<{ runs: Run[] }>(autoRoutes.runs());
      setRuns(runs);
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify]);

  const loadSchedules = useCallback(async () => {
    try {
      const { schedules } = await jsonFetch<{ schedules: Schedule[] }>(autoRoutes.schedules());
      setSchedules(schedules);
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify]);

  const loadWebhooks = useCallback(async () => {
    try {
      const { webhooks } = await jsonFetch<{ webhooks: Webhook[] }>(autoRoutes.webhooks());
      setWebhooks(webhooks);
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify]);

  // The inference-mode preference (managed vs BYO routing) still lives on the
  // legacy byo-key status endpoint; we only read the mode from it now (the
  // provider key surface moved to the generalized provider manager below).
  const loadByo = useCallback(async () => {
    try {
      const status = await jsonFetch<{ inferenceMode: "auto" | "managed" | "byo" }>(autoRoutes.byoKey());
      setByoMode(status.inferenceMode);
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify]);

  // The user's configured providers (any type), the default selection, and the
  // catalog that drives the add/update form. Same shape forge-web Settings reads.
  const loadProviders = useCallback(async () => {
    try {
      const res = await jsonFetch<{
        providers?: PublicProvider[];
        defaultProviderId?: string;
        catalog?: CatalogEntry[];
      }>("/api/auto/ai-providers");
      setProviders(res.providers ?? []);
      setDefaultProviderId(res.defaultProviderId);
      setCatalog(res.catalog ?? []);
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify]);

  // The user's default per-run budget + the resolved effective value. Failure is
  // non-fatal: the forms fall back to a generic note and runs still resolve the
  // budget server-side.
  const loadRunBudget = useCallback(async () => {
    try {
      const res = await jsonFetch<{
        userDefaultCents: number | null;
        effectiveCents: number;
        systemFallbackCents: number;
      }>("/api/auto/run-budget");
      setRunBudget(res);
      setRunBudgetDraftUsd(res.userDefaultCents !== null ? (res.userDefaultCents / 100).toFixed(2) : "");
    } catch {
      /* non-fatal — forms show the system fallback note */
    }
  }, []);

  const saveRunBudget = useCallback(async () => {
    // Blank = clear the default (back to unlimited) → send 0; otherwise a positive amount.
    const trimmed = runBudgetDraftUsd.trim();
    let cents: number;
    if (trimmed === "") {
      cents = 0;
    } else {
      cents = Math.round(parseFloat(trimmed) * 100);
      if (!Number.isInteger(cents) || cents <= 0) {
        notify("Default run budget must be a positive amount, or blank for unlimited.", true);
        return;
      }
    }
    setRunBudgetBusy(true);
    try {
      const res = await jsonFetch<{
        userDefaultCents: number | null;
        effectiveCents: number;
        systemFallbackCents: number;
      }>("/api/auto/run-budget", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ budgetCents: cents })
      });
      setRunBudget(res);
      notify("Default run budget saved.");
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setRunBudgetBusy(false);
    }
  }, [runBudgetDraftUsd, notify]);

  // Auto v2 billing snapshot. Failure is non-fatal (the endpoint already degrades
  // to an unmetered snapshot); leave billing null and the credits panel hides.
  const loadBilling = useCallback(async () => {
    try {
      const summary = await jsonFetch<AutoBillingSummary>("/api/auto/billing");
      setBilling(summary);
    } catch {
      /* non-fatal — credits panel stays hidden */
    }
  }, []);

  // The user's PROTECTED entitled Market kits, for the "run on Auto" picker.
  // Gated on `marketEnabled`: a free open-core self-host never calls this and the
  // picker stays hidden. The route itself also fails closed (empty on Market
  // disabled / service error), so this is defense in depth.
  const loadEntitled = useCallback(async () => {
    if (!marketEnabled) return;
    try {
      const { kits: list } = await jsonFetch<{ kits: EntitledKit[] }>("/api/auto/entitled-kits");
      setEntitled(Array.isArray(list) ? list : []);
    } catch {
      /* non-fatal — picker stays hidden / empty */
    }
  }, [marketEnabled]);

  // The managed model catalog (Claude + GPT) for the create forms' model pickers.
  // Empty `models` (BYO-only self-host, or `disabled: true`) hides every picker.
  const loadManagedModels = useCallback(async () => {
    try {
      const res = await jsonFetch<{ models?: ManagedModel[]; defaultModel?: string | null; disabled?: true }>(
        "/api/managed/models"
      );
      setManagedModels(res.disabled ? [] : (res.models ?? []));
      setManagedDefaultModel(res.defaultModel ?? "");
    } catch {
      /* non-fatal — pickers stay hidden */
    }
  }, []);

  useEffect(() => {
    void loadApprovals();
    void loadRuns();
    void loadSchedules();
    void loadWebhooks();
    void loadByo();
    void loadProviders();
    void loadRunBudget();
    void loadBilling();
    void loadEntitled();
    void loadManagedModels();
  }, [
    loadApprovals,
    loadRuns,
    loadSchedules,
    loadWebhooks,
    loadByo,
    loadProviders,
    loadRunBudget,
    loadBilling,
    loadEntitled,
    loadManagedModels
  ]);

  // The catalog filtered to the deployment's allowed provider types (disallowed
  // are hidden from the form; the server enforces the lock regardless).
  const visibleCatalog = catalog.filter((c) => isAllowed(c.providerType));
  const selectedCat = visibleCatalog.find((c) => c.providerType === provType);

  // Keep the selected provider type within the allowed/known set (e.g. once the
  // catalog loads, or if the default "anthropic" is locked out by the operator).
  useEffect(() => {
    if (visibleCatalog.length > 0 && !visibleCatalog.some((c) => c.providerType === provType)) {
      setProvType(visibleCatalog[0].providerType);
    }
  }, [visibleCatalog, provType]);

  // Deep-link: `?kit=market:<slug>` (optionally `&kitId=<marketKitId>`) from the
  // Market "Run on Auto" action. Pre-select that protected kit in the approval +
  // run forms once the entitled list is loaded (so the option exists). We don't
  // auto-run — the user still authorizes + confirms the credits disclosure. The
  // param is read once; we then strip it so a refresh doesn't re-trigger.
  const [deepLinkApplied, setDeepLinkApplied] = useState(false);
  useEffect(() => {
    if (deepLinkApplied || !marketEnabled) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const slug = parseMarketDeepLink(params.get("kit"));
    if (!slug) return;
    // Only pre-select once the kit is in the entitled list (the option exists and
    // the user is genuinely entitled). Wait for the list before applying.
    if (entitled.length === 0) return;
    const match = entitled.find((k) => k.slug === slug);
    if (!match) {
      setDeepLinkApplied(true); // not entitled / not found — nothing to select.
      notify("You don't have an active purchase for that kit, or it isn't available.", true);
      return;
    }
    const value = marketSelectionValue(match.slug);
    setApprKitId(value);
    setRunKitId(value);
    setDeepLinkApplied(true);
    notify(`Selected "${match.name}" — authorize it, then start a run.`);
    // Strip the query param so a refresh doesn't re-apply it.
    const url = new URL(window.location.href);
    url.searchParams.delete("kit");
    url.searchParams.delete("kitId");
    window.history.replaceState({}, "", url.toString());
  }, [deepLinkApplied, marketEnabled, entitled, notify]);

  // Poll the open run + the list while a run is active.
  useEffect(() => {
    if (!openRunId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const run = await jsonFetch<Run>(autoRoutes.run(openRunId));
        if (!cancelled) setOpenRun(run);
      } catch {
        /* transient */
      }
    };
    void tick();
    const iv = setInterval(() => {
      if (!cancelled) {
        void tick();
        void loadRuns();
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [openRunId, loadRuns]);

  // The set of selector VALUES (local kitId OR `market:<slug>`) that have a live
  // standing approval — used to filter the run/schedule/webhook kit pickers.
  const approvedSelectionValues = new Set<string>(
    approvals.map((a) =>
      a.kitRef.source === "market" && a.kitRef.slug
        ? marketSelectionValue(a.kitRef.slug)
        : (a.kitRef.localKitId ?? "")
    )
  );

  /** The standing (non-revoked) approval for a selector value, if any. */
  const approvalForSelection = (value: string): Approval | undefined => {
    if (isMarketSelection(value)) {
      const slug = value.slice(MARKET_PREFIX.length);
      return approvals.find((a) => a.kitRef.source === "market" && a.kitRef.slug === slug && a.revokedAt === null);
    }
    return approvals.find((a) => a.kitRef.localKitId === value && a.revokedAt === null);
  };

  /** A human label for a selector value (local kit name or entitled Market name). */
  const selectionLabel = (value: string): string => {
    if (isMarketSelection(value)) {
      const slug = value.slice(MARKET_PREFIX.length);
      const kit = entitled.find((k) => k.slug === slug);
      return kit ? `${kit.name} (Market)` : `${slug} (Market)`;
    }
    return kits.find((k) => k.kitId === value)?.name ?? value;
  };

  /** Render the kit <option>s for a selector: local kits, then (if Market is
   *  enabled) the user's entitled protected kits. `onlyApproved` restricts to
   *  kits that already have a standing approval (run/schedule/webhook forms). */
  const renderKitOptions = (onlyApproved: boolean) => (
    <>
      {kits
        .filter((k) => !onlyApproved || approvedSelectionValues.has(k.kitId))
        .map((k) => (
          <option key={k.kitId} value={k.kitId}>
            {k.name}
          </option>
        ))}
      {marketEnabled && entitled.length > 0 && (
        <optgroup label="Purchased (protected) kits">
          {entitled
            .filter((k) => !onlyApproved || approvedSelectionValues.has(marketSelectionValue(k.slug)))
            .map((k) => (
              <option key={k.slug} value={marketSelectionValue(k.slug)}>
                {k.name}
              </option>
            ))}
        </optgroup>
      )}
    </>
  );

  const submitApproval = async () => {
    if (!apprKitId) return notify("Pick a kit to authorize.", true);
    const kitRef = parseKitSelection(apprKitId, entitled);
    if (!kitRef) return notify("That kit is no longer available.", true);
    // The per-run budget ceiling is resolved server-side (see Settings).
    // Phase C: assemble the network policy. An allowlist requires at least one host.
    let networkPolicy: NetworkPolicy = { mode: "deny_all" };
    if (apprNetMode === "allowlist") {
      const hosts = apprNetHosts
        .split(/[\n,]/)
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0);
      if (hosts.length === 0) {
        return notify("Add at least one allowed host, or switch to deny all.", true);
      }
      networkPolicy = { mode: "allowlist", hosts };
    }
    // http_fetch is only meaningful with an allowlist; include it then.
    const toolAllowlist =
      apprNetMode === "allowlist" && apprHttpFetch ? [...apprTools, HTTP_FETCH_TOOL] : apprTools;
    setApprBusy(true);
    try {
      await jsonFetch<Approval>(autoRoutes.approvals(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kitRef, toolAllowlist, networkPolicy })
      });
      notify("Standing approval created.");
      await loadApprovals();
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setApprBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await jsonFetch(autoRoutes.revokeApproval(id), { method: "POST" });
      notify("Approval revoked.");
      await loadApprovals();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  // ---- BYO provider manager + inference-mode preference (Phase 2) ----
  // A small helper that runs a provider mutation, then reloads the list.
  const providerMutation = async (
    body: Record<string, unknown>,
    okMessage: string
  ): Promise<void> => {
    setProvBusy(true);
    try {
      await jsonFetch("/api/auto/ai-providers", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      notify(okMessage);
      await loadProviders();
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setProvBusy(false);
    }
  };

  // Add OR update a provider of any allowed type (apiKey + optional baseUrl +
  // model). The server encrypts the key at rest, never echoes it back, and
  // enforces the provider-lock. Omitting the key on an update keeps the existing
  // one (so a key-less edit of name/model/baseUrl doesn't wipe the key).
  const saveProvider = async () => {
    if (!isAllowed(provType)) return notify("That provider type is not allowed here.", true);
    const key = provApiKey.trim();
    // anthropic/openai/gemini/openai-compatible require a key on first add; ollama
    // does not. We only block when the catalog says a key is required AND none is
    // configured yet for a NEW provider.
    if ((selectedCat?.apiKeyRequired ?? true) && !key && !byoHasKey) {
      return notify("Enter an API key for this provider.", true);
    }
    await providerMutation(
      {
        action: "save",
        provider: {
          name: provName.trim() || provType,
          providerType: provType,
          baseUrl: provBaseUrl.trim(),
          defaultModel: provModel.trim() || selectedCat?.defaultModel || "",
          supportsStructuredJson: selectedCat?.supportsStructuredJson ?? false,
          ...(key ? { apiKey: key } : {})
        }
      },
      "Provider saved (key encrypted at rest)."
    );
    setProvApiKey("");
    setProvName("");
    setProvModel("");
    setProvBaseUrl("");
  };

  const removeProvider = (id: string) =>
    providerMutation({ action: "remove", providerId: id }, "Provider removed.");

  const setDefaultProvider = (id: string) =>
    providerMutation({ action: "setDefault", providerId: id }, "Default provider set.");

  const saveByoMode = async (mode: "auto" | "managed" | "byo") => {
    setByoMode(mode);
    try {
      await jsonFetch(autoRoutes.byoKey(), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inferenceMode: mode })
      });
      notify("Inference preference saved.");
    } catch (e) {
      notify(errMsg(e), true);
      void loadByo();
    }
  };

  const startRun = async () => {
    if (!runKitId) return notify("Pick a kit (one with a standing approval).", true);
    const kitRef = parseKitSelection(runKitId, entitled);
    if (!kitRef) return notify("That kit is no longer available.", true);
    if (!runPrompt.trim()) return notify("Enter a task for the run.", true);
    // The per-run budget is resolved server-side (see Settings).
    setRunBusy(true);
    try {
      // Phase C: stage any selected input files first — request presigned PUT
      // URLs, upload each file's bytes, then attach the returned manifest. The
      // worker hydrates them into the run workspace inputs/ dir.
      let inputFiles: { path: string; s3Key?: string }[] | undefined;
      if (runInputFiles.length > 0) {
        const { slots, inputFiles: manifest } = await jsonFetch<{
          slots: { path: string; s3Key: string; uploadUrl: string }[];
          inputFiles: { path: string; s3Key?: string }[];
        }>(autoRoutes.runInputsUploadUrl(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            files: runInputFiles.map((f) => ({ path: f.name, contentType: f.type || "application/octet-stream" }))
          })
        });
        // Upload each file's bytes to its presigned URL (order matches slots).
        await Promise.all(
          slots.map(async (slot, i) => {
            const file = runInputFiles[i];
            const put = await fetch(slot.uploadUrl, {
              method: "PUT",
              headers: { "content-type": file.type || "application/octet-stream" },
              body: file
            });
            if (!put.ok) throw new Error(`Upload failed for ${file.name} (HTTP ${put.status}).`);
          })
        );
        inputFiles = manifest;
      }

      // Phase D: opt-in delivery (email + signed webhook) assembled from the form.
      const deliveryConfig = buildDeliveryConfig(runDelivery);
      const { id } = await jsonFetch<{ id: string }>(autoRoutes.runs(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kitRef,
          input: { prompt: runPrompt },
          ...(inputFiles && inputFiles.length > 0 ? { inputFiles } : {}),
          ...(deliveryConfig ? { deliveryConfig } : {}),
          ...(runInferenceMode ? { inferenceMode: runInferenceMode } : {}),
          ...(runModel ? { model: runModel } : {})
        })
      });
      notify("Run started.");
      setRunPrompt("");
      setRunInputFiles([]);
      setRunDelivery(EMPTY_DELIVERY);
      setRunInferenceMode("");
      setRunModel("");
      setOpenRunId(id);
      await loadRuns();
      // The run consumes free minutes / balance — refresh the billing snapshot.
      void loadBilling();
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setRunBusy(false);
    }
  };

  const cancelRun = async (id: string) => {
    try {
      await jsonFetch(autoRoutes.cancelRun(id), { method: "POST" });
      notify("Cancellation requested.");
      await loadRuns();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const createSchedule = async () => {
    if (!schedKitId) return notify("Pick a kit (one with a standing approval).", true);
    const kitRef = parseKitSelection(schedKitId, entitled);
    if (!kitRef) return notify("That kit is no longer available.", true);
    const approval = approvalForSelection(schedKitId);
    if (!approval) return notify("That kit has no standing approval.", true);
    // Resolve the cron string: the friendly picker for known cadences, or the raw
    // cron field in Advanced mode.
    const cron =
      schedRepeat === "advanced"
        ? schedCron.trim()
        : recurrenceToCron(schedRepeat, { time: schedTime, dayOfWeek: schedDow, dayOfMonth: schedDom });
    if (!cron) return notify("Enter a cron expression.", true);
    if (!schedPrompt.trim()) return notify("Enter a task for the schedule.", true);
    // The per-run budget is resolved server-side (see Settings).
    setSchedBusy(true);
    try {
      // Phase D: opt-in delivery copied onto every run this schedule fires.
      const deliveryConfig = buildDeliveryConfig(schedDelivery);
      await jsonFetch<Schedule>(autoRoutes.schedules(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kitRef,
          cron,
          timezone: schedTz.trim() || "UTC",
          input: { prompt: schedPrompt },
          approvalId: approval.id,
          ...(deliveryConfig ? { deliveryConfig } : {}),
          ...(schedModel ? { model: schedModel } : {})
        })
      });
      notify("Schedule created.");
      setSchedPrompt("");
      setSchedDelivery(EMPTY_DELIVERY);
      setSchedModel("");
      await loadSchedules();
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setSchedBusy(false);
    }
  };

  const toggleSchedule = async (s: Schedule) => {
    try {
      await jsonFetch<Schedule>(autoRoutes.schedule(s.id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !s.enabled })
      });
      await loadSchedules();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const removeSchedule = async (id: string) => {
    try {
      await jsonFetch(autoRoutes.schedule(id), { method: "DELETE" });
      notify("Schedule deleted.");
      await loadSchedules();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const createWebhook = async () => {
    if (!whKitId) return notify("Pick a kit (one with a standing approval).", true);
    const kitRef = parseKitSelection(whKitId, entitled);
    if (!kitRef) return notify("That kit is no longer available.", true);
    const approval = approvalForSelection(whKitId);
    if (!approval) return notify("That kit has no standing approval.", true);
    // The per-fire budget is resolved server-side (see Settings).
    setWhBusy(true);
    try {
      // Phase D: opt-in delivery copied onto every run this webhook fires.
      const deliveryConfig = buildDeliveryConfig(whDelivery);
      const created = await jsonFetch<CreatedWebhook>(autoRoutes.webhooks(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kitRef,
          approvalId: approval.id,
          ...(deliveryConfig ? { deliveryConfig } : {}),
          ...(whModel ? { model: whModel } : {})
        })
      });
      // Show the plaintext secret + ingest URL ONCE — never retrievable again.
      setWhSecret({ secret: created.secret, ingestUrl: created.ingestUrl });
      setWhDelivery(EMPTY_DELIVERY);
      setWhModel("");
      notify("Webhook created. Copy the secret now — it is shown only once.");
      await loadWebhooks();
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setWhBusy(false);
    }
  };

  const toggleWebhook = async (w: Webhook) => {
    try {
      await jsonFetch<Webhook>(autoRoutes.webhook(w.id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !w.enabled })
      });
      await loadWebhooks();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const removeWebhook = async (id: string) => {
    try {
      await jsonFetch(autoRoutes.webhook(id), { method: "DELETE" });
      notify("Webhook deleted.");
      await loadWebhooks();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  // Label a kit from a persisted kitRef (handles both local and Market sources).
  const kitRefLabel = (ref: { source?: string; localKitId?: string; marketKitId?: string; slug?: string }) => {
    if (ref.source === "market") {
      const kit = ref.slug ? entitled.find((k) => k.slug === ref.slug) : undefined;
      return kit ? `${kit.name} (Market)` : `${ref.slug ?? ref.marketKitId ?? "kit"} (Market)`;
    }
    return kits.find((k) => k.kitId === ref.localKitId)?.name ?? ref.localKitId ?? "(unknown kit)";
  };

  // Read-only per-run budget note shown on the run/schedule/webhook/approval
  // forms now that the budget is resolved server-side (Settings tab). Uses the
  // resolved effective value when known, else a generic note.
  const budgetNote = (
    <p className="form-copy" style={{ marginTop: 0 }}>
      Per-run budget:{" "}
      <strong>{runBudget ? (runBudget.effectiveCents > 0 ? centsToUsd(runBudget.effectiveCents) : "Unlimited") : "set in Settings"}</strong>
      {" "}(the per-run cap; Unlimited uses the kit&apos;s approval ceiling). Change it on the <strong>Settings</strong> tab; an org admin can override it.
    </p>
  );

  return (
    <div style={brandVars(AUTO_GREEN, AUTO_GREEN_STRONG)}>
      {section === "approvals" && (
      <div className="form-layout">
      <div className="form-panel">
        {/* ---- Standing approval ---- */}
        <h3 style={{ marginTop: 0 }}>Authorize a kit</h3>
        <p className="form-copy">
          A standing approval lets Auto run a kit autonomously (no per-step confirm). The tool allowlist is your
          consent; Auto can only use file tools confined to a per-run workspace. There is no autonomous shell.
        </p>
        <Field label="Kit">
          <Select value={apprKitId} onChange={(e) => setApprKitId(e.target.value)}>
            <option value="">Select a kit…</option>
            {renderKitOptions(false)}
          </Select>
        </Field>
        {isMarketSelection(apprKitId) && (
          <p className="form-copy" style={{ marginTop: -4 }}>
            This is a purchased <strong>protected</strong> kit. It runs server-side on Auto and is billed to your
            Auto credits; its contents are never downloaded to you.
          </p>
        )}
        <Field label="Allowed tools">
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {SANDBOX_TOOLS.map((t) => (
              <label key={t} style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto", minHeight: 0 }}
                  checked={apprTools.includes(t)}
                  onChange={(e) =>
                    setApprTools((prev) => (e.target.checked ? [...prev, t] : prev.filter((x) => x !== t)))
                  }
                />
                <code>{t}</code>
              </label>
            ))}
          </div>
        </Field>
        {budgetNote}

        {/* ---- Network egress policy (Phase C) ---- */}
        <Field label="Network access">
          <Select value={apprNetMode} onChange={(e) => setApprNetMode(e.target.value as "deny_all" | "allowlist")}>
            <option value="deny_all">Deny all (no network egress)</option>
            <option value="allowlist">Allow listed hosts only</option>
          </Select>
        </Field>
        {apprNetMode === "allowlist" && (
          <>
            <Field label="Allowed hosts (one per line; exact host or *.suffix)">
              <Textarea
                rows={3}
                value={apprNetHosts}
                onChange={(e) => setApprNetHosts(e.target.value)}
                placeholder={"api.example.com\n*.githubusercontent.com"}
              />
            </Field>
            <Field label="Outbound fetch tool">
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto", minHeight: 0 }}
                  checked={apprHttpFetch}
                  onChange={(e) => setApprHttpFetch(e.target.checked)}
                />
                <span>
                  Allow network fetch (<code>{HTTP_FETCH_TOOL}</code>)
                </span>
              </label>
              <p className="form-copy" style={{ marginTop: 6 }}>
                This grants the kit OUTBOUND network access to the hosts listed above (https only, SSRF-guarded).
                The kit can read from and send data to those hosts on your behalf during a run.
              </p>
            </Field>
          </>
        )}

        <Button disabled={apprBusy} loading={apprBusy} onClick={() => void submitApproval()}>
          {apprBusy ? "Creating…" : "Create approval"}
        </Button>
      </div>
      <div className="results-panel">
          <h4 style={{ marginTop: 0 }}>Active approvals</h4>
          {approvals.length === 0 ? (
            <p className="form-copy">No standing approvals yet.</p>
          ) : (
            approvals.map((a) => (
              <div key={a.id} className="provider-card" style={{ marginBottom: 8, padding: "8px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: "0.85em" }}>
                    <strong>{kitRefLabel(a.kitRef)}</strong>
                    <div style={{ color: "var(--color-text-secondary)" }}>
                      {a.toolAllowlist.join(", ") || "no tools"} · ceiling{" "}
                      {a.maxBudgetCents > 0 ? centsToUsd(a.maxBudgetCents) : "Unlimited"}
                    </div>
                    <div style={{ marginTop: 4 }}>
                      {typeof a.networkPolicy === "object" && a.networkPolicy.mode === "allowlist" ? (
                        <Pill tone="brand">net: {a.networkPolicy.hosts.join(", ")}</Pill>
                      ) : (
                        <Pill tone="neutral">net: deny all</Pill>
                      )}
                    </div>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => void revoke(a.id)}>
                    Revoke
                  </Button>
                </div>
              </div>
            ))
          )}
      </div>
      </div>
      )}

      {section === "settings" && (
      <div className="form-layout">
      <div className="form-panel">
        {/* ---- Inference & billing (BYO key) — Phase 2 ---- */}
        <h3 style={{ marginTop: 0 }}>Inference &amp; billing</h3>
        <p className="form-copy">
          Choose how your runs pay for inference. <strong>Managed credits</strong> use the platform key
          (debited from your prepaid balance). <strong>Bring your own provider</strong> runs on a provider
          you configure below (Anthropic, OpenAI, Gemini, Ollama, or any OpenAI-compatible endpoint) — no
          inference debit. Keys are encrypted at rest and never shown again.
        </p>
        {/* Auto v2 run fee: surfaced when this deployment meters runs (hosted).
            Applies to BYO too — a BYO run pays nothing for inference but still
            owes the per-run fee, so BYO users see balance + free minutes here. On
            a FREE self-host `billing.metered` is false and this panel is hidden
            (runs are unmetered). */}
        {billing?.metered && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
              margin: "0 0 12px"
            }}
          >
            <Pill tone="brand">balance: ${(billing.balanceCents / 100).toFixed(2)}</Pill>
            <Pill tone={billing.freeMinutesRemaining > 0 ? "brand" : "neutral"}>
              {billing.freeMinutesRemaining} / {billing.freeMinutesPerMonth} free trial min left
            </Pill>
          </div>
        )}
        {billing?.metered && (
          <p className="form-copy" style={{ marginTop: 0 }}>
            Each run costs a {billing.invocationFeeCents}¢ start fee plus {billing.activeMinuteRateCents}¢
            per active minute (your first {billing.freeMinutesPerMonth} active minutes are a free one-time trial).
            This applies to bring-your-own-key runs too — you still pay your own provider for tokens.
          </p>
        )}
        {/* Buy credits → the existing Market credits page (no new page). Shown
            whenever a Market URL is configured; metered deployments especially
            need it (BYO included). */}
        {marketUrl && (
          <div style={{ marginBottom: 12 }}>
            <a href={`${marketUrl}/account/credits`} style={{ textDecoration: "none" }}>
              <Button variant="secondary" size="sm">Buy credits</Button>
            </a>
          </div>
        )}
        <Field label="Inference mode">
          <Select value={byoMode} onChange={(e) => void saveByoMode(e.target.value as "auto" | "managed" | "byo")}>
            <option value="auto">Automatic (use my provider when set, else managed)</option>
            <option value="managed">Managed credits (platform key)</option>
            <option value="byo" disabled={!byoHasKey || !byoEnabled}>
              My own provider{byoHasKey ? "" : " (add a provider first)"}
            </option>
          </Select>
        </Field>

        {/* ---- Default run budget (Phase 2.5) ----
            One per-run cap used by every run/schedule/webhook you start (the run
            stops once it spends this much). The forms no longer ask per run. An
            org admin can set an org-level default that OVERRIDES this. */}
        <h4 style={{ margin: "12px 0 4px" }}>Default run budget</h4>
        <p className="form-copy" style={{ marginTop: 0 }}>
          The per-run cap (USD) for every AgentKitAuto run, schedule, and webhook you start — a run stops
          once it spends this much. Leave blank for UNLIMITED (a run is then capped only by the kit&apos;s
          approval ceiling). If your organization sets an org-level default, that OVERRIDES this for all
          members.{" "}
          {runBudget && (
            <>
              Effective now:{" "}
              <strong>{runBudget.effectiveCents > 0 ? centsToUsd(runBudget.effectiveCents) : "Unlimited"}</strong>
              {runBudget.userDefaultCents === null ? " (unlimited by default — set your own below)" : ""}
              .
            </>
          )}
        </p>
        <Field label="Default run budget (USD)">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={runBudgetDraftUsd}
              placeholder="Unlimited"
              onChange={(e) => setRunBudgetDraftUsd(e.target.value)}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={runBudgetBusy || !runBudgetDraftUsd.trim()}
              loading={runBudgetBusy}
              onClick={() => void saveRunBudget()}
            >
              {runBudgetBusy ? "Saving…" : "Save"}
            </Button>
          </div>
        </Field>

        {/* ---- BYO provider manager ----
            A provider of ANY of the 5 types can be added; the run-resolution path
            reads the user's DEFAULT provider (any type) from the same store. The
            form hides types disallowed by ALLOWED_PROVIDERS; the server enforces
            the lock regardless. When EVERY type is locked out the whole manager is
            hidden (runs use managed credits). */}
        {byoEnabled && (
          <>
            <h4 style={{ margin: "12px 0 4px" }}>Your AI providers</h4>
            {providers.length === 0 ? (
              <p className="form-copy" style={{ marginTop: 0 }}>No providers configured yet.</p>
            ) : (
              <div className="results-panel" style={{ marginBottom: 12 }}>
                {providers.map((p) => (
                  <div key={p.id} className="provider-card" style={{ marginBottom: 8, padding: "8px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <div style={{ fontSize: "0.85em" }}>
                        <strong>{p.name}</strong>{" "}
                        {p.id === defaultProviderId && <Badge tone="success">default</Badge>}
                        <div style={{ color: "var(--color-text-secondary)" }}>
                          {p.providerType} · {p.defaultModel || "no model"}
                          {p.baseUrl ? ` · ${p.baseUrl}` : ""} ·{" "}
                          {p.hasApiKey ? "key set (••••)" : "no key"}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        {p.id !== defaultProviderId && (
                          <Button variant="secondary" size="sm" disabled={provBusy} onClick={() => void setDefaultProvider(p.id)}>
                            Make default
                          </Button>
                        )}
                        <Button variant="secondary" size="sm" disabled={provBusy} onClick={() => void removeProvider(p.id)}>
                          Remove
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {!byoEnabled && (
          <p className="form-copy">
            Bring-your-own-provider is disabled by this deployment&apos;s provider policy. Runs use managed credits.
          </p>
        )}
      </div>
      <div className="results-panel">
        {byoEnabled && (
          <>
            <h4 style={{ marginTop: 0 }}>Add / update a provider</h4>
            <Field label="Provider type">
              <Select value={provType} onChange={(e) => setProvType(e.target.value)}>
                {visibleCatalog.length === 0 && isAllowed("anthropic") && (
                  <option value="anthropic">anthropic</option>
                )}
                {visibleCatalog.map((c) => (
                  <option key={c.providerType} value={c.providerType}>
                    {c.providerType}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Display name (optional)">
              <Input value={provName} onChange={(e) => setProvName(e.target.value)} placeholder={provType} />
            </Field>
            <Field label="Default model (optional)">
              {selectedCat && selectedCat.models.length > 0 ? (
                <Select value={provModel} onChange={(e) => setProvModel(e.target.value)}>
                  <option value="">
                    {selectedCat.defaultModel ? `default (${selectedCat.defaultModel})` : "select…"}
                  </option>
                  {selectedCat.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input value={provModel} onChange={(e) => setProvModel(e.target.value)} />
              )}
            </Field>
            {selectedCat?.baseUrlRequired && (
              <Field label="Base URL (required for OpenAI-compatible / Ollama endpoints)">
                <Input value={provBaseUrl} onChange={(e) => setProvBaseUrl(e.target.value)} placeholder="https://…" />
              </Field>
            )}
            {(selectedCat?.apiKeyRequired ?? true) && (
              <Field label="API key (stored server-side encrypted, never echoed back)">
                <Input
                  type="password"
                  autoComplete="off"
                  value={provApiKey}
                  onChange={(e) => setProvApiKey(e.target.value)}
                  placeholder={byoHasKey ? "leave blank to keep an existing key" : ""}
                />
              </Field>
            )}
            <Button disabled={provBusy} loading={provBusy} onClick={() => void saveProvider()}>
              {provBusy ? "Saving…" : "Save provider"}
            </Button>
          </>
        )}
      </div>
      </div>
      )}

      {section === "run" && (
      <div className="form-layout form-layout--single">
      <div className="form-panel">
        {/* ---- Start a run ---- */}
        <h3 style={{ marginTop: 0 }}>Start a run</h3>
        <Field label="Kit (must have an approval)">
          <Select value={runKitId} onChange={(e) => setRunKitId(e.target.value)}>
            <option value="">Select a kit…</option>
            {renderKitOptions(true)}
          </Select>
        </Field>
        {/* ---- "Costs Auto credits" disclosure for a PROTECTED run (Part C) ----
            Shown before starting a run of a protected Market kit. Reads the LIVE
            rates/balance from /api/auto/billing (no hardcoded prices). Honest
            about: server-side execution, output delivery (not the kit files), and
            the residual prompt-extraction risk. Only on metered deployments with a
            protected kit selected. */}
        {creditsDisclosureKind(runKitId, billing?.metered === true) === "full" && billing && (
          <Card style={{ margin: "0 0 12px", padding: "12px 14px" }}>
            <h4 style={{ marginTop: 0 }}>This run costs Auto credits</h4>
            <p className="form-copy" style={{ marginTop: 0 }}>
              <strong>{selectionLabel(runKitId)}</strong> is a purchased protected kit. It runs on AgentKitAuto and is
              billed to <strong>your</strong> Auto credits: a {billing.invocationFeeCents}¢ start fee plus{" "}
              {billing.activeMinuteRateCents}¢ per active minute (your first {billing.freeMinutesPerMonth} active
              minutes are a free one-time trial).
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "4px 0 8px" }}>
              <Pill tone="brand">balance: ${(billing.balanceCents / 100).toFixed(2)}</Pill>
              <Pill tone={billing.freeMinutesRemaining > 0 ? "brand" : "neutral"}>
                {billing.freeMinutesRemaining} / {billing.freeMinutesPerMonth} free trial min left
              </Pill>
              {marketUrl && (
                <a href={`${marketUrl}/account/credits`} style={{ textDecoration: "none" }}>
                  <Button variant="secondary" size="sm">Buy credits</Button>
                </a>
              )}
            </div>
            <p className="form-copy" style={{ marginTop: 0, marginBottom: 0 }}>
              The kit runs server-side and you receive its <strong>output</strong> — the kit&apos;s files are never
              downloaded to you. (Protected kits resist, but cannot fully prevent, a determined attempt to extract
              their instructions from the output.)
            </p>
          </Card>
        )}
        {creditsDisclosureKind(runKitId, billing?.metered === true) === "brief" && (
          <p className="form-copy">
            <strong>{selectionLabel(runKitId)}</strong> is a purchased protected kit. It runs server-side on Auto and
            you receive its output; the kit&apos;s files are never downloaded to you.
          </p>
        )}
        <Field label="Task">
          <Textarea rows={4} value={runPrompt} onChange={(e) => setRunPrompt(e.target.value)} placeholder="What should the kit do, end to end?" />
        </Field>
        {budgetNote}
        {/* ---- Inference mode for THIS run (Phase 2) ----
            Hidden for a protected Market kit: it FORCES managed inference (a BYO
            key would route the server-fetched kit prompt through the buyer's own
            provider console, leaking it). The server coerces this regardless. */}
        {!isMarketSelection(runKitId) && (
          <Field label="Inference for this run">
            <Select value={runInferenceMode} onChange={(e) => setRunInferenceMode(e.target.value as "" | "managed" | "byo")}>
              <option value="">Use my account preference</option>
              <option value="managed">Managed credits (this run)</option>
              <option value="byo" disabled={!byoHasKey}>
                My own key (this run){byoHasKey ? "" : " — add a key first"}
              </option>
            </Select>
          </Field>
        )}
        {/* ---- Managed model picker (managed models only; hidden for BYO-only self-host) ---- */}
        {managedModels.length > 0 && (
          <Field label="Model">
            <Select value={runModel} onChange={(e) => setRunModel(e.target.value)}>
              <option value="">Default ({managedDefaultModel})</option>
              {groupModelsByProvider(managedModels).map(([provider, group]) => (
                <optgroup key={provider} label={PROVIDER_GROUP_LABEL[provider]}>
                  {group.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
        )}
        {/* ---- Input files (Phase C) ---- */}
        <Field label="Input files (optional)">
          <input
            type="file"
            multiple
            onChange={(e) => setRunInputFiles(Array.from(e.target.files ?? []))}
          />
          {runInputFiles.length > 0 && (
            <ul style={{ fontSize: "0.8em", margin: "6px 0 0", paddingLeft: 18 }}>
              {runInputFiles.map((f) => (
                <li key={f.name}>
                  <code>inputs/{f.name}</code> ({f.size} bytes)
                </li>
              ))}
            </ul>
          )}
          <p className="form-copy" style={{ marginTop: 6 }}>
            Files are uploaded to your run&apos;s <code>inputs/</code> directory before it starts, so the kit can read them.
          </p>
        </Field>
        {/* ---- Deliver result (Phase D) ---- */}
        <DeliverySection value={runDelivery} onChange={setRunDelivery} scopeNoun="run" />
        <Button disabled={runBusy} loading={runBusy} onClick={() => void startRun()}>
          {runBusy ? "Starting…" : "Start run"}
        </Button>
      </div>
      </div>
      )}

      {section === "schedules" && (
      <div className="form-layout">
      <div className="form-panel">
        {/* ---- Schedules (Phase B) ---- */}
        <h3 style={{ marginTop: 0 }}>Schedules</h3>
        <p className="form-copy">
          A schedule fires a run automatically on a cron cadence, under the kit&apos;s standing approval and a
          per-run budget. Each fire is still gated by the approval — a schedule never widens consent.
        </p>
        <Field label="Kit (must have an approval)">
          <Select value={schedKitId} onChange={(e) => setSchedKitId(e.target.value)}>
            <option value="">Select a kit…</option>
            {renderKitOptions(true)}
          </Select>
        </Field>
        {/* ---- Friendly recurrence picker (primary) + Advanced cron escape hatch ---- */}
        <Field label="Repeat">
          <Select value={schedRepeat} onChange={(e) => setSchedRepeat(e.target.value as RecurrenceKind)}>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="advanced">Advanced (cron)</option>
          </Select>
        </Field>
        {(schedRepeat === "daily" || schedRepeat === "weekly" || schedRepeat === "monthly") && (
          <Field label="At time">
            <Input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} />
          </Field>
        )}
        {schedRepeat === "weekly" && (
          <Field label="On day">
            <Select value={String(schedDow)} onChange={(e) => setSchedDow(Number(e.target.value) as DayOfWeek)}>
              <option value="1">Monday</option>
              <option value="2">Tuesday</option>
              <option value="3">Wednesday</option>
              <option value="4">Thursday</option>
              <option value="5">Friday</option>
              <option value="6">Saturday</option>
              <option value="0">Sunday</option>
            </Select>
          </Field>
        )}
        {schedRepeat === "monthly" && (
          <Field label="On day of month (1–31)">
            <Input
              type="number"
              min="1"
              max="31"
              step="1"
              value={schedDom}
              onChange={(e) => setSchedDom(Number(e.target.value))}
            />
          </Field>
        )}
        {schedRepeat === "advanced" && (
          <Field label="Cron (minute hour dom month dow)">
            <Input type="text" value={schedCron} onChange={(e) => setSchedCron(e.target.value)} placeholder="0 9 * * *" />
          </Field>
        )}
        <Field label="Timezone (IANA)">
          <Input type="text" value={schedTz} onChange={(e) => setSchedTz(e.target.value)} placeholder="UTC" />
        </Field>
        <Field label="Task">
          <Textarea rows={3} value={schedPrompt} onChange={(e) => setSchedPrompt(e.target.value)} placeholder="What should the kit do on each run?" />
        </Field>
        {/* ---- Managed model picker (managed models only; hidden for BYO-only self-host) ---- */}
        {managedModels.length > 0 && (
          <Field label="Model">
            <Select value={schedModel} onChange={(e) => setSchedModel(e.target.value)}>
              <option value="">Default ({managedDefaultModel})</option>
              {groupModelsByProvider(managedModels).map(([provider, group]) => (
                <optgroup key={provider} label={PROVIDER_GROUP_LABEL[provider]}>
                  {group.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
        )}
        {budgetNote}
        {/* ---- Deliver result (Phase D) ---- */}
        <DeliverySection value={schedDelivery} onChange={setSchedDelivery} scopeNoun="scheduled run" />
        <Button disabled={schedBusy} loading={schedBusy} onClick={() => void createSchedule()}>
          {schedBusy ? "Creating…" : "Create schedule"}
        </Button>
      </div>
      <div className="results-panel">
          <h4 style={{ marginTop: 0 }}>Active schedules</h4>
          {schedules.length === 0 ? (
            <p className="form-copy">No schedules yet.</p>
          ) : (
            schedules.map((s) => (
              <div key={s.id} className="provider-card" style={{ marginBottom: 8, padding: "8px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: "0.85em" }}>
                    <strong>{kitRefLabel(s.kitRef)}</strong>{" "}
                    <code style={{ fontSize: "0.9em" }}>{s.cron}</code>{" "}
                    <span style={{ color: "var(--color-text-secondary)" }}>({s.timezone})</span>
                    <div style={{ color: "var(--color-text-secondary)" }}>
                      {centsToUsd(s.budgetCents)}/run · next <ClientTime ts={s.nextRunAt} /> · last <ClientTime ts={s.lastRunAt} />
                    </div>
                    {s.lastError && (
                      <div style={{ color: "var(--color-error)" }}>last error: {s.lastError}</div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 400, fontSize: "0.8em" }}>
                      <input type="checkbox" checked={s.enabled} onChange={() => void toggleSchedule(s)} />
                      {s.enabled ? "on" : "off"}
                    </label>
                    <Button variant="secondary" size="sm" onClick={() => void removeSchedule(s.id)}>
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
      </div>
      </div>
      )}

      {section === "webhooks" && (
      <div className="form-layout">
      <div className="form-panel">
        {/* ---- Triggers (webhook-backed; Phase C) ---- */}
        <h3 style={{ marginTop: 0 }}>Triggers</h3>
        <p className="form-copy">
          A trigger fires a run when a third-party service POSTs to its webhook URL, authed by a per-trigger secret
          (no login). Each fire is still gated by the kit&apos;s standing approval and a per-fire budget — a trigger
          never widens consent.
        </p>
        <Field label="Kit (must have an approval)">
          <Select value={whKitId} onChange={(e) => setWhKitId(e.target.value)}>
            <option value="">Select a kit…</option>
            {renderKitOptions(true)}
          </Select>
        </Field>
        {/* ---- Managed model picker (managed models only; hidden for BYO-only self-host) ---- */}
        {managedModels.length > 0 && (
          <Field label="Model">
            <Select value={whModel} onChange={(e) => setWhModel(e.target.value)}>
              <option value="">Default ({managedDefaultModel})</option>
              {groupModelsByProvider(managedModels).map(([provider, group]) => (
                <optgroup key={provider} label={PROVIDER_GROUP_LABEL[provider]}>
                  {group.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
        )}
        {budgetNote}
        {/* ---- Deliver result (Phase D) ---- */}
        <DeliverySection value={whDelivery} onChange={setWhDelivery} scopeNoun="webhook-fired run" />
        <Button disabled={whBusy} loading={whBusy} onClick={() => void createWebhook()}>
          {whBusy ? "Creating…" : "Create webhook"}
        </Button>

        {whSecret && (
          <Card style={{ marginTop: 12, padding: "12px 14px" }}>
            <h4 style={{ marginTop: 0 }}>Copy your webhook secret now</h4>
            <p className="form-copy">
              This secret is shown <strong>only once</strong> and is never retrievable again. Send it as the
              <code> x-auto-webhook-secret</code> header (or <code>?token=</code> query param) when calling the URL.
            </p>
            <Field label="Ingest URL">
              <Input type="text" readOnly value={whSecret.ingestUrl} onFocus={(e) => e.currentTarget.select()} />
            </Field>
            <Field label="Secret (shown once)">
              <Input type="text" readOnly value={whSecret.secret} onFocus={(e) => e.currentTarget.select()} />
            </Field>
            <Button variant="secondary" size="sm" onClick={() => setWhSecret(null)}>
              I&apos;ve copied it
            </Button>
          </Card>
        )}
      </div>
      <div className="results-panel">
          <h4 style={{ marginTop: 0 }}>Active webhooks</h4>
          {webhooks.length === 0 ? (
            <p className="form-copy">No webhooks yet.</p>
          ) : (
            webhooks.map((w) => (
              <div key={w.id} className="provider-card" style={{ marginBottom: 8, padding: "8px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: "0.85em", overflow: "hidden" }}>
                    <strong>{kitRefLabel(w.kitRef)}</strong>
                    <div style={{ color: "var(--color-text-secondary)" }}>
                      {centsToUsd(w.budgetCents)}/fire · fired {w.fireCount}× · last <ClientTime ts={w.lastFiredAt} />
                    </div>
                    <div style={{ color: "var(--color-text-secondary)", wordBreak: "break-all", fontSize: "0.9em" }}>
                      <code>{w.ingestUrl}</code>
                    </div>
                    {w.lastError && <div style={{ color: "var(--color-error)" }}>last error: {w.lastError}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 400, fontSize: "0.8em" }}>
                      <input type="checkbox" checked={w.enabled} onChange={() => void toggleWebhook(w)} />
                      {w.enabled ? "on" : "off"}
                    </label>
                    <Button variant="secondary" size="sm" onClick={() => void removeWebhook(w.id)}>
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
      </div>
      </div>
      )}

      {section === "runs" && (
      <div className="form-layout">
      <div className="form-panel">
        {/* ---- Run history + detail ---- */}
        <h3 style={{ marginTop: 0 }}>Runs</h3>
        {runs.length === 0 ? (
          <p className="form-copy">No runs yet.</p>
        ) : (
          runs.map((r) => (
            <div
              key={r.id}
              className="provider-card"
              style={{ marginBottom: 8, padding: "8px 12px", cursor: "pointer", outline: openRunId === r.id ? "1px solid var(--color-accent)" : "none" }}
              onClick={() => setOpenRunId(r.id)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", fontSize: "0.85em" }}>
                <strong>{kitRefLabel(r.kitRef)}</strong>
                <Badge tone={ACTIVE.has(r.status) ? "brand" : "neutral"}>{r.status}</Badge>
              </div>
              <div style={{ fontSize: "0.78em", color: "var(--color-text-secondary)" }}>
                {centsToUsd(r.spentCents)} / {centsToUsd(r.budgetCents)} · <ClientTime ts={r.createdAt} />
              </div>
            </div>
          ))
        )}
      </div>
      <div className="results-panel">
        {!openRun && <p className="form-copy">Select a run on the left to see its output and audit log.</p>}
        {openRun && (
          <div className="provider-card" style={{ marginTop: 0, padding: "12px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h4 style={{ margin: 0 }}>Run detail</h4>
              {ACTIVE.has(openRun.status) && (
                <Button variant="secondary" size="sm" onClick={() => void cancelRun(openRun.id)}>
                  Cancel
                </Button>
              )}
            </div>
            <p style={{ fontSize: "0.82em", color: "var(--color-text-secondary)", margin: "6px 0" }}>
              <strong>{openRun.status}</strong> · {centsToUsd(openRun.spentCents)} / {centsToUsd(openRun.budgetCents)} · {openRun.model}
            </p>
            {openRun.error && <p style={{ color: "var(--color-error)", fontSize: "0.82em" }}>{openRun.error}</p>}

            {openRun.result?.output && (
              <>
                <h5 style={{ margin: "8px 0 4px" }}>Output</h5>
                <pre className="json-panel" style={{ whiteSpace: "pre-wrap", maxHeight: 220 }}>{openRun.result.output}</pre>
              </>
            )}

            {openRun.result?.files && openRun.result.files.length > 0 && (
              <>
                <h5 style={{ margin: "8px 0 4px" }}>Produced files</h5>
                <ul style={{ fontSize: "0.8em", margin: 0, paddingLeft: 18 }}>
                  {openRun.result.files.map((f) => (
                    <li key={f.path}>
                      <code>{f.path}</code> ({f.sizeBytes} bytes)
                    </li>
                  ))}
                </ul>
              </>
            )}

            {openRun.outputFiles && openRun.outputFiles.length > 0 && (
              <>
                <h5 style={{ margin: "8px 0 4px" }}>Output downloads</h5>
                <ul style={{ fontSize: "0.8em", margin: 0, paddingLeft: 18 }}>
                  {openRun.outputFiles.map((f) => (
                    <li key={f.path}>
                      <a href={runOutputHref(openRun.id, f.path)} target="_blank" rel="noreferrer">
                        <code>{f.path}</code>
                      </a>{" "}
                      ({f.sizeBytes} bytes)
                    </li>
                  ))}
                </ul>
              </>
            )}

            {openRun.auditLog && openRun.auditLog.length > 0 && (
              <>
                <h5 style={{ margin: "10px 0 4px" }}>Audit log</h5>
                <div style={{ fontSize: "0.76em", fontFamily: "var(--font-mono, monospace)" }}>
                  {openRun.auditLog.map((e, i) => (
                    <div key={i} style={{ color: e.outcome === "ok" ? "inherit" : "var(--color-error)" }}>
                      {e.tool}({e.argsSummary}) → {e.outcome}
                      {e.detail ? ` — ${e.detail}` : ""}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      </div>
      )}
    </div>
  );
}
