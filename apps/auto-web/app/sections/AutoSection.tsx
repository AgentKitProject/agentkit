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
import { Badge, Button, Card, Field, Input, Pill, Select, Textarea, brandVars } from "@agentkitforge/ui";
import { autoRoutes } from "@agentkitforge/contracts";
import type { MyKitEntry, Notify } from "./shared";
import { errMsg } from "./shared";
import { AutoLogo } from "./AutoLogo";
import { ClientTime } from "./ClientTime";

// AgentKitAuto accent. Wrapping the section in brandVars(AUTO_GREEN) re-themes
// every framework primitive (buttons, badges, focus rings, active nav) inside
// it to Auto green, while the rest of the app stays Forge indigo.
const AUTO_GREEN = "#16a34a";
const AUTO_GREEN_STRONG = "#15803d";

// Phase-A sandbox tools the user can authorize. NO run_command (no autonomous shell).
const SANDBOX_TOOLS = ["read_file", "list_dir", "write_file"] as const;
// Phase C: the network-egress tool. Available to a run only when the approval's
// networkPolicy is an allowlist AND this tool is in the allowlist.
const HTTP_FETCH_TOOL = "http_fetch";

type KitRef = { source: "local"; localKitId: string };

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
  auditLog?: AuditEntry[];
};

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

export function AutoSection({ kits, notify }: { kits: MyKitEntry[]; notify: Notify }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<Run | null>(null);

  // Approval form state.
  const [apprKitId, setApprKitId] = useState("");
  const [apprTools, setApprTools] = useState<string[]>(["read_file", "list_dir"]);
  const [apprBudgetUsd, setApprBudgetUsd] = useState("1.00");
  const [apprBusy, setApprBusy] = useState(false);
  // Phase C: network egress policy on the approval form.
  const [apprNetMode, setApprNetMode] = useState<"deny_all" | "allowlist">("deny_all");
  const [apprNetHosts, setApprNetHosts] = useState(""); // newline/comma-separated host patterns
  const [apprHttpFetch, setApprHttpFetch] = useState(false);

  // Run form state.
  const [runKitId, setRunKitId] = useState("");
  const [runPrompt, setRunPrompt] = useState("");
  const [runBudgetUsd, setRunBudgetUsd] = useState("0.50");
  const [runBusy, setRunBusy] = useState(false);
  // Phase C: user-provided input files staged via presigned upload then attached
  // to the run as a manifest. Selected files are uploaded on run start.
  const [runInputFiles, setRunInputFiles] = useState<File[]>([]);
  // Phase D: opt-in result-delivery fields for the run.
  const [runDelivery, setRunDelivery] = useState<DeliveryFields>(EMPTY_DELIVERY);

  // Webhook state (Phase C).
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [whKitId, setWhKitId] = useState("");
  const [whBudgetUsd, setWhBudgetUsd] = useState("0.50");
  const [whBusy, setWhBusy] = useState(false);
  // The one-time plaintext secret + ingest URL, shown ONCE after creation.
  const [whSecret, setWhSecret] = useState<{ secret: string; ingestUrl: string } | null>(null);
  // Phase D: opt-in result-delivery fields for webhook-fired runs.
  const [whDelivery, setWhDelivery] = useState<DeliveryFields>(EMPTY_DELIVERY);

  // Schedule state (Phase B).
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [schedKitId, setSchedKitId] = useState("");
  const [schedCron, setSchedCron] = useState("0 9 * * *");
  const [schedTz, setSchedTz] = useState(localTimezone());
  const [schedPrompt, setSchedPrompt] = useState("");
  const [schedBudgetUsd, setSchedBudgetUsd] = useState("0.50");
  const [schedBusy, setSchedBusy] = useState(false);
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

  useEffect(() => {
    void loadApprovals();
    void loadRuns();
    void loadSchedules();
    void loadWebhooks();
  }, [loadApprovals, loadRuns, loadSchedules, loadWebhooks]);

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

  const kitsWithApproval = approvals
    .map((a) => a.kitRef.localKitId)
    .filter((id): id is string => typeof id === "string");

  const submitApproval = async () => {
    if (!apprKitId) return notify("Pick a kit to authorize.", true);
    const cents = Math.round(parseFloat(apprBudgetUsd) * 100);
    if (!Number.isInteger(cents) || cents <= 0) return notify("Max budget must be a positive amount.", true);
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
      const kitRef: KitRef = { source: "local", localKitId: apprKitId };
      await jsonFetch<Approval>(autoRoutes.approvals(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kitRef, toolAllowlist, maxBudgetCents: cents, networkPolicy })
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

  const startRun = async () => {
    if (!runKitId) return notify("Pick a kit (one with a standing approval).", true);
    if (!runPrompt.trim()) return notify("Enter a task for the run.", true);
    const cents = Math.round(parseFloat(runBudgetUsd) * 100);
    if (!Number.isInteger(cents) || cents <= 0) return notify("Run budget is required (positive amount).", true);
    setRunBusy(true);
    try {
      const kitRef: KitRef = { source: "local", localKitId: runKitId };

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
          budgetCents: cents,
          ...(inputFiles && inputFiles.length > 0 ? { inputFiles } : {}),
          ...(deliveryConfig ? { deliveryConfig } : {})
        })
      });
      notify("Run started.");
      setRunPrompt("");
      setRunInputFiles([]);
      setRunDelivery(EMPTY_DELIVERY);
      setOpenRunId(id);
      await loadRuns();
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

  // The standing approval for a local kit id (schedules must reference one).
  const approvalForKit = (kitId: string): Approval | undefined =>
    approvals.find((a) => a.kitRef.localKitId === kitId && a.revokedAt === null);

  const createSchedule = async () => {
    if (!schedKitId) return notify("Pick a kit (one with a standing approval).", true);
    const approval = approvalForKit(schedKitId);
    if (!approval) return notify("That kit has no standing approval.", true);
    if (!schedCron.trim()) return notify("Enter a cron expression.", true);
    if (!schedPrompt.trim()) return notify("Enter a task for the schedule.", true);
    const cents = Math.round(parseFloat(schedBudgetUsd) * 100);
    if (!Number.isInteger(cents) || cents <= 0) return notify("Per-run budget is required (positive amount).", true);
    setSchedBusy(true);
    try {
      const kitRef: KitRef = { source: "local", localKitId: schedKitId };
      // Phase D: opt-in delivery copied onto every run this schedule fires.
      const deliveryConfig = buildDeliveryConfig(schedDelivery);
      await jsonFetch<Schedule>(autoRoutes.schedules(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kitRef,
          cron: schedCron.trim(),
          timezone: schedTz.trim() || "UTC",
          input: { prompt: schedPrompt },
          budgetCents: cents,
          approvalId: approval.id,
          ...(deliveryConfig ? { deliveryConfig } : {})
        })
      });
      notify("Schedule created.");
      setSchedPrompt("");
      setSchedDelivery(EMPTY_DELIVERY);
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
    const approval = approvalForKit(whKitId);
    if (!approval) return notify("That kit has no standing approval.", true);
    const cents = Math.round(parseFloat(whBudgetUsd) * 100);
    if (!Number.isInteger(cents) || cents <= 0) return notify("Per-fire budget is required (positive amount).", true);
    setWhBusy(true);
    try {
      const kitRef: KitRef = { source: "local", localKitId: whKitId };
      // Phase D: opt-in delivery copied onto every run this webhook fires.
      const deliveryConfig = buildDeliveryConfig(whDelivery);
      const created = await jsonFetch<CreatedWebhook>(autoRoutes.webhooks(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kitRef,
          budgetCents: cents,
          approvalId: approval.id,
          ...(deliveryConfig ? { deliveryConfig } : {})
        })
      });
      // Show the plaintext secret + ingest URL ONCE — never retrievable again.
      setWhSecret({ secret: created.secret, ingestUrl: created.ingestUrl });
      setWhDelivery(EMPTY_DELIVERY);
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

  const kitLabel = (id?: string) => kits.find((k) => k.kitId === id)?.name ?? id ?? "(unknown kit)";

  return (
    <div style={brandVars(AUTO_GREEN, AUTO_GREEN_STRONG)}>
      {/* Auto section header: brand logo + name + green accent */}
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
        <AutoLogo size={40} />
        <div style={{ display: "grid", gap: 2 }}>
          <strong style={{ fontSize: "1.15rem", lineHeight: 1.1 }}>AgentKitAuto</strong>
          <span className="eyebrow">Autonomous runs</span>
        </div>
      </header>
      <div className="form-layout">
      <div className="form-panel">
        {/* ---- Standing approval ---- */}
        <h3>Authorize a kit</h3>
        <p className="form-copy">
          A standing approval lets Auto run a kit autonomously (no per-step confirm). The tool allowlist is your
          consent; Auto can only use file tools confined to a per-run workspace. There is no autonomous shell.
        </p>
        <Field label="Kit">
          <Select value={apprKitId} onChange={(e) => setApprKitId(e.target.value)}>
            <option value="">Select a kit…</option>
            {kits.map((k) => (
              <option key={k.kitId} value={k.kitId}>
                {k.name}
              </option>
            ))}
          </Select>
        </Field>
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
        <Field label="Max budget per run (USD)">
          <Input type="number" min="0.01" step="0.01" value={apprBudgetUsd} onChange={(e) => setApprBudgetUsd(e.target.value)} />
        </Field>

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

        <div className="results-panel" style={{ marginTop: 16 }}>
          <h4 style={{ marginTop: 0 }}>Active approvals</h4>
          {approvals.length === 0 ? (
            <p className="form-copy">No standing approvals yet.</p>
          ) : (
            approvals.map((a) => (
              <div key={a.id} className="provider-card" style={{ marginBottom: 8, padding: "8px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: "0.85em" }}>
                    <strong>{kitLabel(a.kitRef.localKitId)}</strong>
                    <div style={{ color: "var(--color-text-secondary)" }}>
                      {a.toolAllowlist.join(", ") || "no tools"} · ceiling {centsToUsd(a.maxBudgetCents)}
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

        {/* ---- Start a run ---- */}
        <h3 style={{ marginTop: 24 }}>Start a run</h3>
        <Field label="Kit (must have an approval)">
          <Select value={runKitId} onChange={(e) => setRunKitId(e.target.value)}>
            <option value="">Select a kit…</option>
            {kits
              .filter((k) => kitsWithApproval.includes(k.kitId))
              .map((k) => (
                <option key={k.kitId} value={k.kitId}>
                  {k.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Task">
          <Textarea rows={4} value={runPrompt} onChange={(e) => setRunPrompt(e.target.value)} placeholder="What should the kit do, end to end?" />
        </Field>
        <Field label="This run's budget (USD, required)">
          <Input type="number" min="0.01" step="0.01" value={runBudgetUsd} onChange={(e) => setRunBudgetUsd(e.target.value)} />
        </Field>
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

        {/* ---- Schedules (Phase B) ---- */}
        <h3 style={{ marginTop: 24 }}>Schedules</h3>
        <p className="form-copy">
          A schedule fires a run automatically on a cron cadence, under the kit&apos;s standing approval and a
          per-run budget. Each fire is still gated by the approval — a schedule never widens consent.
        </p>
        <Field label="Kit (must have an approval)">
          <Select value={schedKitId} onChange={(e) => setSchedKitId(e.target.value)}>
            <option value="">Select a kit…</option>
            {kits
              .filter((k) => kitsWithApproval.includes(k.kitId))
              .map((k) => (
                <option key={k.kitId} value={k.kitId}>
                  {k.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Cron (minute hour dom month dow)">
          <Input type="text" value={schedCron} onChange={(e) => setSchedCron(e.target.value)} placeholder="0 9 * * *" />
        </Field>
        <Field label="Timezone (IANA)">
          <Input type="text" value={schedTz} onChange={(e) => setSchedTz(e.target.value)} placeholder="UTC" />
        </Field>
        <Field label="Task">
          <Textarea rows={3} value={schedPrompt} onChange={(e) => setSchedPrompt(e.target.value)} placeholder="What should the kit do on each run?" />
        </Field>
        <Field label="Per-run budget (USD, required)">
          <Input type="number" min="0.01" step="0.01" value={schedBudgetUsd} onChange={(e) => setSchedBudgetUsd(e.target.value)} />
        </Field>
        {/* ---- Deliver result (Phase D) ---- */}
        <DeliverySection value={schedDelivery} onChange={setSchedDelivery} scopeNoun="scheduled run" />
        <Button disabled={schedBusy} loading={schedBusy} onClick={() => void createSchedule()}>
          {schedBusy ? "Creating…" : "Create schedule"}
        </Button>

        <div className="results-panel" style={{ marginTop: 16 }}>
          <h4 style={{ marginTop: 0 }}>Active schedules</h4>
          {schedules.length === 0 ? (
            <p className="form-copy">No schedules yet.</p>
          ) : (
            schedules.map((s) => (
              <div key={s.id} className="provider-card" style={{ marginBottom: 8, padding: "8px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: "0.85em" }}>
                    <strong>{kitLabel(s.kitRef.localKitId)}</strong>{" "}
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

        {/* ---- Webhooks (Phase C) ---- */}
        <h3 style={{ marginTop: 24 }}>Webhooks</h3>
        <p className="form-copy">
          A webhook fires a run when a third-party service POSTs to its URL, authed by a per-webhook secret (no
          login). Each fire is still gated by the kit&apos;s standing approval and a per-fire budget — a webhook
          never widens consent.
        </p>
        <Field label="Kit (must have an approval)">
          <Select value={whKitId} onChange={(e) => setWhKitId(e.target.value)}>
            <option value="">Select a kit…</option>
            {kits
              .filter((k) => kitsWithApproval.includes(k.kitId))
              .map((k) => (
                <option key={k.kitId} value={k.kitId}>
                  {k.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Per-fire budget (USD, required)">
          <Input type="number" min="0.01" step="0.01" value={whBudgetUsd} onChange={(e) => setWhBudgetUsd(e.target.value)} />
        </Field>
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

        <div className="results-panel" style={{ marginTop: 16 }}>
          <h4 style={{ marginTop: 0 }}>Active webhooks</h4>
          {webhooks.length === 0 ? (
            <p className="form-copy">No webhooks yet.</p>
          ) : (
            webhooks.map((w) => (
              <div key={w.id} className="provider-card" style={{ marginBottom: 8, padding: "8px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: "0.85em", overflow: "hidden" }}>
                    <strong>{kitLabel(w.kitRef.localKitId)}</strong>
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

      {/* ---- Run history + detail ---- */}
      <div className="results-panel">
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
                <strong>{kitLabel(r.kitRef.localKitId)}</strong>
                <Badge tone={ACTIVE.has(r.status) ? "brand" : "neutral"}>{r.status}</Badge>
              </div>
              <div style={{ fontSize: "0.78em", color: "var(--color-text-secondary)" }}>
                {centsToUsd(r.spentCents)} / {centsToUsd(r.budgetCents)} · <ClientTime ts={r.createdAt} />
              </div>
            </div>
          ))
        )}

        {openRun && (
          <div className="provider-card" style={{ marginTop: 12, padding: "12px 14px" }}>
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
    </div>
  );
}
