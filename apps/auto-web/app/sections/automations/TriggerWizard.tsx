"use client";

// The guided "New automation" wizard: WHEN → RUN → DELIVER.
//
//   WHEN    — pick the trigger: "On a schedule" (phrase builder → cron
//             internally, with a next-runs preview + an Advanced raw-cron
//             escape hatch) or "When an event arrives" (pick/create an Event
//             Source inline + provider preset cards with copy-paste setup
//             instructions). "Advanced: raw webhook" points at the legacy
//             Triggers section.
//   RUN     — kit + standing approval + the S1 prompt template (the ONLY
//             instruction source for fired runs) with a clickable field tree
//             from the source's latest event, declarative filters (max 10),
//             and the attach-payload toggle.
//   DELIVER — output destinations (max 5: email / webhook / Slack) + the
//             per-hour rate limit, then a review summary → create.
//
// Also drives EDIT mode: same steps prefilled from an existing Trigger; the
// type is immutable (PATCH keeps the trigger's type; config is only sent for
// the schedule/event shapes this wizard edits).
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Field, Input, Pill, Select, Textarea } from "@agentkitforge/ui";
import type {
  AutoApproval,
  CreateEventSourceResponse,
  CreateTriggerRequest,
  Destination,
  KitRef,
  PublicEventSource,
  ReceivedEvent,
  Trigger,
  TriggerFilter,
  TriggerFilterOp,
  UpdateTriggerRequest
} from "@agentkitforge/contracts";
import type { MyKitEntry, Notify } from "../shared";
import { errMsg } from "../shared";
import {
  MARKET_PREFIX,
  isMarketSelection,
  marketSelectionValue,
  parseKitSelection,
  type EntitledKit
} from "../market-kit-ref";
import {
  cronToPhrase,
  describePhrase,
  nextFires,
  phraseToCron,
  validateCronSyntax,
  type DayOfWeek,
  type PhraseFrequency,
  type SchedulePhrase
} from "@/lib/automations/cron";
import {
  createEventSource,
  createTrigger,
  listSourceEvents,
  updateTrigger
} from "@/lib/automations/client";
import { buildEmitUrl, presetById, PROVIDER_PRESETS } from "@/lib/automations/presets";
import { insertPlaceholderAt } from "@/lib/automations/field-tree";
import type { AutomationTemplate } from "@/lib/automations/template-link";
import { FieldTree } from "./FieldTree";

const FILTER_OPS: { op: TriggerFilterOp; label: string }[] = [
  { op: "eq", label: "equals" },
  { op: "ne", label: "does not equal" },
  { op: "gt", label: "greater than" },
  { op: "gte", label: "at least" },
  { op: "lt", label: "less than" },
  { op: "lte", label: "at most" },
  { op: "contains", label: "contains" },
  { op: "exists", label: "exists" },
  { op: "matches", label: "matches pattern" }
];

const STEPS = ["when", "run", "deliver"] as const;
type Step = (typeof STEPS)[number];

/** The browser's IANA timezone (the phrase builder default). */
function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Common IANA zones offered in the select; the user's own zone is prepended. */
const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Australia/Sydney"
];

/** Selector value for a persisted kitRef (local id or `market:<slug>`). */
function kitRefToSelection(ref: KitRef): string {
  if (ref.source === "market" && ref.slug) return marketSelectionValue(ref.slug);
  return ref.localKitId ?? "";
}

type FilterDraft = { path: string; op: TriggerFilterOp; value: string };

function filtersToDrafts(filters: TriggerFilter[] | undefined): FilterDraft[] {
  return (filters ?? []).map((f) => ({
    path: f.path,
    op: f.op,
    value: f.value === undefined || f.value === null ? "" : String(f.value)
  }));
}

/** Coerce a filter draft value back to the JSON scalar the contract carries. */
function draftValue(raw: string): string | number | boolean | null {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return raw;
}

export type WizardInitial =
  | { mode: "create"; template?: AutomationTemplate }
  | { mode: "edit"; trigger: Trigger };

export function TriggerWizard({
  initial,
  kits,
  entitled,
  approvals,
  sources,
  notify,
  onSourcesChanged,
  onDone
}: {
  initial: WizardInitial;
  kits: MyKitEntry[];
  entitled: EntitledKit[];
  approvals: AutoApproval[];
  sources: PublicEventSource[];
  notify: Notify;
  /** Reload the parent's event-source list (after inline create). */
  onSourcesChanged: () => Promise<void> | void;
  /** Close the wizard; `changed` = a trigger was created/updated. */
  onDone: (changed: boolean) => void;
}) {
  const editTrigger = initial.mode === "edit" ? initial.trigger : null;
  const template = initial.mode === "create" ? initial.template : undefined;

  // ---- WHEN ----
  const [step, setStep] = useState<Step>("when");
  // "schedule" | "event" are wizard-built; "other" = editing a trigger type the
  // wizard doesn't build (watch/rss/…): config is shown read-only + untouched.
  const [kind, setKind] = useState<"schedule" | "event" | "other" | null>(() => {
    if (editTrigger) {
      return editTrigger.type === "schedule" ? "schedule" : editTrigger.type === "event" ? "event" : "other";
    }
    if (template?.trigger.type === "schedule") return "schedule";
    if (template?.trigger.type === "event") return "event";
    return null;
  });
  const [name, setName] = useState(editTrigger?.name ?? template?.name ?? "");

  // Schedule phrase state (prefilled from an edited/template cron when it maps).
  const initialCron =
    editTrigger?.type === "schedule"
      ? editTrigger.config.cron
      : typeof template?.trigger.config?.cron === "string"
        ? (template.trigger.config.cron as string)
        : null;
  const initialPhrase = initialCron ? cronToPhrase(initialCron) : null;
  const [freq, setFreq] = useState<PhraseFrequency>(initialPhrase?.frequency ?? "daily");
  const [time, setTime] = useState(initialPhrase?.time ?? "09:00");
  const [minute, setMinute] = useState(initialPhrase?.minute ?? 0);
  const [dow, setDow] = useState<DayOfWeek>(initialPhrase?.dayOfWeek ?? 1);
  const [dom, setDom] = useState(initialPhrase?.dayOfMonth ?? 1);
  const [timezone, setTimezone] = useState(
    (editTrigger?.type === "schedule" ? editTrigger.config.timezone : undefined) ??
      (typeof template?.trigger.config?.timezone === "string"
        ? (template.trigger.config.timezone as string)
        : undefined) ??
      localTimezone()
  );
  // Advanced raw-cron escape hatch (auto-on when the cron isn't a builder shape).
  const [advancedCron, setAdvancedCron] = useState(initialCron !== null && initialPhrase === null);
  const [rawCron, setRawCron] = useState(initialCron ?? "0 9 * * *");

  const phrase: SchedulePhrase = { frequency: freq, time, minute, dayOfWeek: dow, dayOfMonth: dom };
  const effectiveCron = advancedCron ? rawCron.trim() : phraseToCron(phrase);
  const cronError = advancedCron ? validateCronSyntax(rawCron) : null;
  const preview = cronError === null ? nextFires(effectiveCron, timezone, Date.now(), 3) : [];

  // Event-source state.
  const [sourceId, setSourceId] = useState<string>(() => {
    if (editTrigger?.type === "event") return editTrigger.config.sourceId;
    const t = template?.trigger.config?.sourceId;
    return typeof t === "string" ? t : "";
  });
  const [eventName, setEventName] = useState<string>(() => {
    if (editTrigger?.type === "event") return editTrigger.config.eventName ?? "";
    const t = template?.trigger.config?.eventName;
    return typeof t === "string" ? t : "";
  });
  const [presetId, setPresetId] = useState<string | null>(null);
  const [newSourceName, setNewSourceName] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [sourceBusy, setSourceBusy] = useState(false);
  // The one-time plaintext token from an inline create — shown ONCE.
  const [createdSource, setCreatedSource] = useState<CreateEventSourceResponse | null>(null);

  const preset = presetId ? presetById(presetId) : undefined;
  const selectedSource = sources.find((s) => s.id === sourceId) ?? createdSource ?? null;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const emitUrl = selectedSource
    ? buildEmitUrl(
        origin,
        selectedSource.id,
        eventName || preset?.defaultEventName || "my-event",
        createdSource && createdSource.id === selectedSource.id ? createdSource.token : undefined
      )
    : null;

  const createSourceInline = async () => {
    const nm = newSourceName.trim() || preset?.label || "My event source";
    setSourceBusy(true);
    try {
      const created = await createEventSource({
        name: nm,
        kind: preset?.provider ? "provider" : "custom",
        ...(preset?.provider ? { provider: preset.provider } : {}),
        ...(preset?.signatureVerified && signingSecret.trim() ? { signingSecret: signingSecret.trim() } : {})
      });
      setCreatedSource(created);
      setSourceId(created.id);
      setSigningSecret("");
      setNewSourceName("");
      if (!eventName && preset) setEventName(preset.defaultEventName);
      notify("Event source created. Copy the token now — it is shown only once.");
      await onSourcesChanged();
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setSourceBusy(false);
    }
  };

  // ---- RUN ----
  const [kitSel, setKitSel] = useState<string>(() =>
    editTrigger ? kitRefToSelection(editTrigger.kitRef) : template?.kitRef ? kitRefToSelection(template.kitRef) : ""
  );
  const [approvalId, setApprovalId] = useState(editTrigger?.approvalId ?? "");
  const [promptTemplate, setPromptTemplate] = useState(
    editTrigger?.mapping.promptTemplate ?? template?.mapping.promptTemplate ?? ""
  );
  const [attachPayload, setAttachPayload] = useState(
    editTrigger ? editTrigger.mapping.attachPayloadAs !== null : true
  );
  const [filters, setFilters] = useState<FilterDraft[]>(filtersToDrafts(editTrigger?.filters));
  // Where a field-tree click lands: the prompt textarea, or a filter row's path.
  const [insertTarget, setInsertTarget] = useState<{ kind: "prompt" } | { kind: "filter"; idx: number }>({
    kind: "prompt"
  });
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [recentEvents, setRecentEvents] = useState<ReceivedEvent[]>([]);

  // Live approvals for the selected kit (the approval gates every fire).
  const liveApprovals = approvals.filter((a) => a.revokedAt === null);
  const kitApprovals = liveApprovals.filter((a) => {
    if (isMarketSelection(kitSel)) {
      return a.kitRef.source === "market" && a.kitRef.slug === kitSel.slice(MARKET_PREFIX.length);
    }
    return a.kitRef.source === "local" && a.kitRef.localKitId === kitSel;
  });
  const selectedApproval =
    kitApprovals.find((a) => a.id === approvalId) ?? (kitApprovals.length === 1 ? kitApprovals[0] : undefined);

  // Keep approvalId in sync with the kit selection.
  useEffect(() => {
    if (kitApprovals.length > 0 && !kitApprovals.some((a) => a.id === approvalId)) {
      setApprovalId(kitApprovals[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kitSel, approvals]);

  // Load the source's recent events (the field tree reads the LATEST one).
  useEffect(() => {
    if (kind !== "event" || !sourceId) {
      setRecentEvents([]);
      return;
    }
    let cancelled = false;
    listSourceEvents(sourceId)
      .then((events) => {
        if (!cancelled) setRecentEvents(events);
      })
      .catch(() => {
        /* non-fatal — tree just stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [kind, sourceId]);

  const latestEvent = recentEvents[0];

  const handleFieldPick = (path: string) => {
    if (insertTarget.kind === "filter") {
      setFilters((prev) => prev.map((f, i) => (i === insertTarget.idx ? { ...f, path } : f)));
      return;
    }
    const el = promptRef.current;
    const cursor = el ? el.selectionStart : promptTemplate.length;
    const next = insertPlaceholderAt(promptTemplate, cursor, path);
    setPromptTemplate(next.text);
    // Restore focus + caret after React re-renders the textarea.
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(next.cursor, next.cursor);
      }
    });
  };

  // S3 invariant surface: an event-driven automation processes UNTRUSTED
  // external content; warn when the chosen approval is not deny-all network.
  const approvalNetworkOpen =
    selectedApproval !== undefined &&
    typeof selectedApproval.networkPolicy === "object" &&
    selectedApproval.networkPolicy !== null &&
    (selectedApproval.networkPolicy as { mode?: string }).mode !== "deny_all";
  const showUntrustedWarning = kind === "event" && approvalNetworkOpen;

  // ---- DELIVER ----
  const [destinations, setDestinations] = useState<Destination[]>(editTrigger?.destinations ?? []);
  const [destType, setDestType] = useState<"email" | "webhook_out" | "slack_incoming">("email");
  const [destEmails, setDestEmails] = useState("");
  const [destUrl, setDestUrl] = useState("");
  const [destSecret, setDestSecret] = useState("");
  const [maxPerHour, setMaxPerHour] = useState(editTrigger?.rateLimit?.maxPerHour ?? 20);
  const [busy, setBusy] = useState(false);

  const addDestination = () => {
    if (destinations.length >= 5) return notify("An automation can have at most 5 destinations.", true);
    let dest: Destination;
    if (destType === "email") {
      const to = destEmails
        .split(/[\s,]+/)
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
      if (to.length === 0) return notify("Enter at least one email recipient.", true);
      if (to.length > 5) return notify("At most 5 email recipients per destination.", true);
      dest = { type: "email", to };
    } else {
      const url = destUrl.trim();
      if (!url.startsWith("https://")) return notify("Destination URLs must be https.", true);
      dest =
        destType === "webhook_out"
          ? { type: "webhook_out", url, ...(destSecret.trim() ? { secret: destSecret.trim() } : {}) }
          : { type: "slack_incoming", url };
    }
    setDestinations((prev) => [...prev, dest]);
    setDestEmails("");
    setDestUrl("");
    setDestSecret("");
  };

  const destinationLabel = (d: Destination): string => {
    switch (d.type) {
      case "email":
        return `Email → ${d.to.join(", ")}`;
      case "webhook_out":
        return `Webhook → ${d.url}${d.secret ? " (signed)" : ""}`;
      case "slack_incoming":
        return `Slack → ${d.url}`;
      case "connection":
        return `Connection → ${d.connectionId}`;
    }
  };

  // ---- validation + submit ----
  const whenReady =
    kind === "other" ||
    (kind === "schedule" && cronError === null && effectiveCron.length > 0) ||
    (kind === "event" && sourceId.length > 0);
  const runReady = kitSel.length > 0 && selectedApproval !== undefined && promptTemplate.trim().length > 0;

  const stepIndex = STEPS.indexOf(step);

  const nextStep = () => {
    if (step === "when") {
      if (!name.trim()) return notify("Name this automation first.", true);
      if (!whenReady) return notify(kind === null ? "Pick a trigger type." : "Finish the trigger setup first.", true);
      setStep("run");
    } else if (step === "run") {
      if (!runReady) {
        return notify(
          !kitSel
            ? "Pick a kit to run."
            : !selectedApproval
              ? "The kit needs a standing approval."
              : "Write the prompt template — it is the only instruction the run receives.",
          true
        );
      }
      setStep("deliver");
    }
  };

  const submit = async () => {
    const kitRef = parseKitSelection(kitSel, entitled);
    if (!kitRef || !selectedApproval) return notify("Pick a kit with a standing approval.", true);
    const trimmedName = name.trim();
    if (!trimmedName) return notify("Name this automation.", true);
    const cleanFilters: TriggerFilter[] = filters
      .filter((f) => f.path.trim().length > 0)
      .map((f) => ({
        path: f.path.trim(),
        op: f.op,
        ...(f.op === "exists" ? {} : { value: draftValue(f.value) })
      }));
    if (cleanFilters.length > 10) return notify("At most 10 filters.", true);
    const mapping = {
      promptTemplate: promptTemplate.trim(),
      attachPayloadAs: attachPayload ? "event.json" : null,
      fileHandling: "attach" as const
    };
    const rateLimit = { maxPerHour: Math.min(500, Math.max(1, Math.trunc(maxPerHour) || 20)) };

    setBusy(true);
    try {
      if (editTrigger) {
        const patch: UpdateTriggerRequest = {
          name: trimmedName,
          approvalId: selectedApproval.id,
          mapping,
          filters: cleanFilters,
          destinations,
          rateLimit,
          // `type` is immutable; only send config for the shapes this wizard edits.
          ...(kind === "schedule"
            ? { config: { cron: effectiveCron, timezone } }
            : kind === "event"
              ? { config: { sourceId, eventName: eventName.trim() ? eventName.trim() : null } }
              : {})
        };
        await updateTrigger(editTrigger.id, patch);
        notify("Automation updated.");
      } else {
        const base = {
          name: trimmedName,
          kitRef,
          approvalId: selectedApproval.id,
          mapping,
          ...(cleanFilters.length > 0 ? { filters: cleanFilters } : {}),
          ...(destinations.length > 0 ? { destinations } : {}),
          rateLimit,
          enabled: true
        };
        const req: CreateTriggerRequest =
          kind === "schedule"
            ? { ...base, type: "schedule", config: { cron: effectiveCron, timezone } }
            : {
                ...base,
                type: "event",
                config: { sourceId, ...(eventName.trim() ? { eventName: eventName.trim() } : {}) }
              };
        await createTrigger(req);
        notify("Automation created.");
      }
      onDone(true);
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  // ---- render helpers ----
  const kitOptions = (
    <>
      {kits.map((k) => (
        <option key={k.kitId} value={k.kitId}>
          {k.name}
        </option>
      ))}
      {entitled.length > 0 && (
        <optgroup label="Purchased (protected) kits">
          {entitled.map((k) => (
            <option key={k.slug} value={marketSelectionValue(k.slug)}>
              {k.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );

  const timezoneOptions = useMemo(() => {
    const local = localTimezone();
    const zones = [local, ...COMMON_TIMEZONES.filter((z) => z !== local)];
    return timezone && !zones.includes(timezone) ? [timezone, ...zones] : zones;
  }, [timezone]);

  const stepBadge = (i: number, label: string) => (
    <Pill key={label} tone={stepIndex === i ? "brand" : "neutral"}>
      {i + 1}. {label}
    </Pill>
  );

  const triggerSummary =
    kind === "schedule"
      ? advancedCron
        ? `Cron ${effectiveCron} (${timezone})`
        : `${describePhrase(phrase)} (${timezone})`
      : kind === "event"
        ? `When "${eventName.trim() || "any"}" events arrive on ${selectedSource?.name ?? "an event source"}`
        : `Existing ${editTrigger?.type ?? ""} trigger (unchanged)`;

  return (
    <div className="form-layout form-layout--single">
      <div className="form-panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <h3 style={{ margin: 0 }}>{editTrigger ? "Edit automation" : "New automation"}</h3>
          <Button variant="secondary" size="sm" onClick={() => onDone(false)}>
            Cancel
          </Button>
        </div>
        <div style={{ display: "flex", gap: 6, margin: "10px 0 14px", flexWrap: "wrap" }}>
          {stepBadge(0, "When")}
          {stepBadge(1, "Run")}
          {stepBadge(2, "Deliver")}
        </div>

        {/* ================= WHEN ================= */}
        {step === "when" && (
          <>
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Morning digest, New GitHub issue triage"
                maxLength={80}
              />
            </Field>

            {kind === "other" && editTrigger && (
              <Card style={{ padding: "12px 14px", marginBottom: 12 }}>
                <p className="form-copy" style={{ margin: 0 }}>
                  This automation&apos;s trigger type is <strong>{editTrigger.type}</strong>, which this wizard
                  doesn&apos;t reconfigure — its trigger settings stay unchanged. You can still edit the name,
                  what it runs, and how it delivers.
                </p>
              </Card>
            )}

            {kind !== "other" && !editTrigger && (
              <Field label="What starts it?">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
                  {(
                    [
                      { k: "schedule" as const, title: "On a schedule", copy: "Run at a time you choose — hourly, daily, weekly…" },
                      { k: "event" as const, title: "When an event arrives", copy: "Run when Zapier, GitHub, Stripe, or any service sends an event." }
                    ] as const
                  ).map((card) => (
                    <Card
                      key={card.k}
                      onClick={() => setKind(card.k)}
                      style={{
                        padding: "12px 14px",
                        cursor: "pointer",
                        outline: kind === card.k ? "2px solid var(--color-accent)" : "none"
                      }}
                    >
                      <strong>{card.title}</strong>
                      <p className="form-copy" style={{ margin: "4px 0 0" }}>
                        {card.copy}
                      </p>
                    </Card>
                  ))}
                </div>
                <p className="form-copy" style={{ marginTop: 8 }}>
                  Advanced: for a raw webhook with a shared secret (legacy), use the{" "}
                  <a href="?section=webhooks">Triggers</a> section — or create an event source here and POST
                  JSON to its emit URL from anything that can make an HTTP request.
                </p>
              </Field>
            )}

            {/* ---- On a schedule: the phrase builder ---- */}
            {kind === "schedule" && (
              <>
                <Field label="How often?">
                  <Select value={freq} onChange={(e) => setFreq(e.target.value as PhraseFrequency)} disabled={advancedCron}>
                    <option value="hourly">Every hour</option>
                    <option value="daily">Every day</option>
                    <option value="weekdays">Weekdays (Mon–Fri)</option>
                    <option value="weekly">Weekly on…</option>
                    <option value="monthly">Monthly on…</option>
                  </Select>
                </Field>
                {!advancedCron && freq === "hourly" && (
                  <Field label="At minute (0–59)">
                    <Input
                      type="number"
                      min="0"
                      max="59"
                      step="1"
                      value={minute}
                      onChange={(e) => setMinute(Number(e.target.value))}
                    />
                  </Field>
                )}
                {!advancedCron && freq !== "hourly" && (
                  <Field label="At time">
                    <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                  </Field>
                )}
                {!advancedCron && freq === "weekly" && (
                  <Field label="On day">
                    <Select value={String(dow)} onChange={(e) => setDow(Number(e.target.value) as DayOfWeek)}>
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
                {!advancedCron && freq === "monthly" && (
                  <Field label="On day of month (1–31)">
                    <Input type="number" min="1" max="31" step="1" value={dom} onChange={(e) => setDom(Number(e.target.value))} />
                  </Field>
                )}
                <Field label="Timezone">
                  <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                    {timezoneOptions.map((z) => (
                      <option key={z} value={z}>
                        {z}
                      </option>
                    ))}
                  </Select>
                </Field>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400, fontSize: "0.85em" }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto", minHeight: 0 }}
                    checked={advancedCron}
                    onChange={(e) => {
                      const on = e.target.checked;
                      if (on) setRawCron(effectiveCron);
                      setAdvancedCron(on);
                    }}
                  />
                  Advanced: edit cron
                </label>
                {advancedCron && (
                  <Field label="Cron (minute hour day-of-month month day-of-week)">
                    <Input value={rawCron} onChange={(e) => setRawCron(e.target.value)} placeholder="0 9 * * *" />
                    {cronError && <p style={{ color: "var(--color-error)", fontSize: "0.8em", margin: "4px 0 0" }}>{cronError}</p>}
                  </Field>
                )}
                <div style={{ margin: "10px 0" }}>
                  <strong style={{ fontSize: "0.85em" }}>Next runs:</strong>{" "}
                  {cronError !== null ? (
                    <span className="form-copy">fix the cron above.</span>
                  ) : preview.length === 0 ? (
                    <span className="form-copy">preview unavailable for this cron (it will still run server-side).</span>
                  ) : (
                    <span style={{ fontSize: "0.85em" }}>
                      {preview
                        .map((d) =>
                          d.toLocaleString(undefined, {
                            timeZone: timezone,
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit"
                          })
                        )
                        .join(" · ")}{" "}
                      <span style={{ color: "var(--color-text-secondary)" }}>({timezone})</span>
                    </span>
                  )}
                </div>
              </>
            )}

            {/* ---- When an event arrives ---- */}
            {kind === "event" && (
              <>
                <Field label="Event source">
                  <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                    <option value="">Create a new source…</option>
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.provider ? ` (${s.provider})` : ""}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Where will events come from? (optional preset)">
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {PROVIDER_PRESETS.map((p) => (
                      <Button
                        key={p.id}
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setPresetId(p.id === presetId ? null : p.id);
                          if (!eventName) setEventName(p.defaultEventName);
                        }}
                        style={p.id === presetId ? { outline: "2px solid var(--color-accent)" } : undefined}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </div>
                </Field>

                {!sourceId && (
                  <>
                    <Field label="Name the new source">
                      <Input
                        value={newSourceName}
                        onChange={(e) => setNewSourceName(e.target.value)}
                        placeholder={preset ? preset.label : "e.g. My Zapier events"}
                        maxLength={80}
                      />
                    </Field>
                    {preset?.signatureVerified && preset.provider !== "sns" && (
                      <Field label={`${preset.label} signing secret (verifies each delivery)`}>
                        <Input
                          type="password"
                          autoComplete="off"
                          value={signingSecret}
                          onChange={(e) => setSigningSecret(e.target.value)}
                          placeholder="paste the provider's signing secret"
                        />
                      </Field>
                    )}
                    <Button disabled={sourceBusy} loading={sourceBusy} onClick={() => void createSourceInline()}>
                      {sourceBusy ? "Creating…" : "Create event source"}
                    </Button>
                  </>
                )}

                {createdSource && sourceId === createdSource.id && (
                  <Card style={{ marginTop: 12, padding: "12px 14px" }}>
                    <h4 style={{ marginTop: 0 }}>Copy your source token now</h4>
                    <p className="form-copy">
                      This token authenticates events sent to your emit URL. It is shown{" "}
                      <strong>only once</strong> — you won&apos;t see it again (you can rotate it later).
                    </p>
                    <Field label="Token (shown once)">
                      <div style={{ display: "flex", gap: 8 }}>
                        <Input type="text" readOnly value={createdSource.token} onFocus={(e) => e.currentTarget.select()} />
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            void navigator.clipboard?.writeText(createdSource.token);
                            notify("Token copied.");
                          }}
                        >
                          Copy
                        </Button>
                      </div>
                    </Field>
                  </Card>
                )}

                <Field label="Only react to this event name (optional)">
                  <Input
                    value={eventName}
                    onChange={(e) => setEventName(e.target.value)}
                    placeholder="blank = all events on this source"
                  />
                  <p className="form-copy" style={{ marginTop: 4 }}>
                    The event name is the last part of the emit URL — one source can carry many named events.
                  </p>
                </Field>

                {selectedSource && emitUrl && (
                  <Card style={{ marginTop: 4, padding: "12px 14px" }}>
                    <h4 style={{ marginTop: 0 }}>{preset ? `Set up ${preset.label}` : "Send events here"}</h4>
                    <Field label="Emit URL">
                      <div style={{ display: "flex", gap: 8 }}>
                        <Input type="text" readOnly value={emitUrl} onFocus={(e) => e.currentTarget.select()} />
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            void navigator.clipboard?.writeText(emitUrl);
                            notify("Emit URL copied.");
                          }}
                        >
                          Copy
                        </Button>
                      </div>
                    </Field>
                    {(preset
                      ? preset.instructions(emitUrl)
                      : [
                          `POST JSON to the URL above from any service or script.`,
                          `Example: curl -X POST '${emitUrl}' -H 'content-type: application/json' -d '{"hello":"world"}'`,
                          "Prefer sending the token as a header instead of the URL: Authorization: Bearer <token>."
                        ]
                    ).map((line, i) => (
                      <p key={i} className="form-copy" style={{ margin: "4px 0", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {i + 1}. {line}
                      </p>
                    ))}
                    {emitUrl.includes("<YOUR_TOKEN>") && (
                      <p className="form-copy" style={{ marginTop: 6 }}>
                        Replace <code>&lt;YOUR_TOKEN&gt;</code> with the source token you saved at creation
                        (or rotate the token to get a new one).
                      </p>
                    )}
                  </Card>
                )}
              </>
            )}
          </>
        )}

        {/* ================= RUN ================= */}
        {step === "run" && (
          <>
            <Field label="Kit to run (needs a standing approval)">
              <Select value={kitSel} onChange={(e) => setKitSel(e.target.value)}>
                <option value="">Select a kit…</option>
                {kitOptions}
              </Select>
            </Field>
            {kitSel && kitApprovals.length === 0 && (
              <p className="form-copy" style={{ color: "var(--color-error)" }}>
                This kit has no standing approval yet — <a href="?section=approvals">create one</a> first
                (the approval is your consent for autonomous runs).
              </p>
            )}
            {kitApprovals.length > 0 && (
              <Field label="Run under approval">
                <Select value={selectedApproval?.id ?? ""} onChange={(e) => setApprovalId(e.target.value)}>
                  {kitApprovals.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.toolAllowlist.join(", ") || "no tools"} ·{" "}
                      {typeof a.networkPolicy === "object" && (a.networkPolicy as { mode?: string }).mode === "allowlist"
                        ? "network allowlist"
                        : "no network"}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {showUntrustedWarning && (
              <Card style={{ padding: "12px 14px", marginBottom: 12, borderLeft: "3px solid var(--color-error, #dc2626)" }}>
                <p className="form-copy" style={{ margin: 0 }}>
                  <strong>This automation processes untrusted external content — it will run with network
                  access.</strong>{" "}
                  Event payloads come from outside; a kit with network egress could be steered into sending
                  data out. Prefer a deny-all approval unless network access is genuinely required.
                </p>
              </Card>
            )}

            <Field label="Prompt template (the only instructions the run receives)">
              <Textarea
                ref={promptRef}
                rows={5}
                value={promptTemplate}
                onChange={(e) => setPromptTemplate(e.target.value)}
                onFocus={() => setInsertTarget({ kind: "prompt" })}
                placeholder={
                  kind === "event"
                    ? "e.g. Summarize the new issue titled {{issue.title}} and draft a reply."
                    : "e.g. Compile the daily report from the files in inputs/."
                }
                maxLength={4000}
              />
              <p className="form-copy" style={{ marginTop: 4 }}>
                Event data is <strong>data, not instructions</strong>: <code>{"{{field.path}}"}</code>{" "}
                placeholders insert event <em>values</em> into this template; the raw payload can ride along
                as a file. The event can never rewrite your instructions.
              </p>
            </Field>

            {kind === "event" && (
              <Field label={latestEvent ? "Insert a field from the latest event (click to insert)" : "Insert fields"}>
                {latestEvent ? (
                  <>
                    <p className="form-copy" style={{ margin: "0 0 6px" }}>
                      From <code>{latestEvent.name}</code> received{" "}
                      {new Date(latestEvent.receivedAt).toLocaleString()}. Clicking inserts{" "}
                      <code>{"{{path}}"}</code>{" "}
                      {insertTarget.kind === "prompt" ? "into the prompt at the cursor." : "into the focused filter's field."}
                    </p>
                    <FieldTree payload={latestEvent.payload} onPick={handleFieldPick} />
                  </>
                ) : (
                  <p className="form-copy" style={{ margin: 0 }}>
                    No events received yet on this source. Send a test event to the emit URL (step 1) and the
                    fields will show up here as a clickable tree.
                  </p>
                )}
              </Field>
            )}

            {/* ---- Filters (declarative, max 10) ---- */}
            <Field label="Only run when… (optional filters — all must match)">
              {filters.map((f, i) => (
                <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                  <Input
                    value={f.path}
                    onChange={(e) => setFilters((prev) => prev.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}
                    onFocus={() => setInsertTarget({ kind: "filter", idx: i })}
                    placeholder="field path (e.g. action)"
                    style={{ flex: 2 }}
                  />
                  <Select
                    value={f.op}
                    onChange={(e) =>
                      setFilters((prev) => prev.map((x, j) => (j === i ? { ...x, op: e.target.value as TriggerFilterOp } : x)))
                    }
                    style={{ flex: 1.4 }}
                  >
                    {FILTER_OPS.map((o) => (
                      <option key={o.op} value={o.op}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  {f.op !== "exists" && (
                    <Input
                      value={f.value}
                      onChange={(e) => setFilters((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                      placeholder="value"
                      style={{ flex: 1.4 }}
                    />
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setFilters((prev) => prev.filter((_, j) => j !== i));
                      setInsertTarget({ kind: "prompt" });
                    }}
                  >
                    ✕
                  </Button>
                </div>
              ))}
              {filters.length < 10 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setFilters((prev) => [...prev, { path: "", op: "eq", value: "" }])}
                >
                  + Add filter
                </Button>
              )}
            </Field>

            {kind === "event" && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400, fontSize: "0.85em" }}>
                <input
                  type="checkbox"
                  style={{ width: "auto", minHeight: 0 }}
                  checked={attachPayload}
                  onChange={(e) => setAttachPayload(e.target.checked)}
                />
                Attach the full event payload as <code>event.json</code> in the run workspace
              </label>
            )}
          </>
        )}

        {/* ================= DELIVER ================= */}
        {step === "deliver" && (
          <>
            <Field label={`Send the result to… (optional, up to 5) — ${destinations.length}/5`}>
              {destinations.map((d, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: "0.85em", wordBreak: "break-all" }}>{destinationLabel(d)}</span>
                  <Button variant="secondary" size="sm" onClick={() => setDestinations((prev) => prev.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </div>
              ))}
              {destinations.length < 5 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                  <Select value={destType} onChange={(e) => setDestType(e.target.value as typeof destType)}>
                    <option value="email">Email</option>
                    <option value="webhook_out">Webhook (https)</option>
                    <option value="slack_incoming">Slack incoming webhook</option>
                  </Select>
                  {destType === "email" ? (
                    <Input
                      value={destEmails}
                      onChange={(e) => setDestEmails(e.target.value)}
                      placeholder="you@example.com, ops@example.com (max 5)"
                    />
                  ) : (
                    <>
                      <Input
                        type="url"
                        value={destUrl}
                        onChange={(e) => setDestUrl(e.target.value)}
                        placeholder={destType === "slack_incoming" ? "https://hooks.slack.com/services/…" : "https://example.com/result"}
                      />
                      {destType === "webhook_out" && (
                        <Input
                          value={destSecret}
                          onChange={(e) => setDestSecret(e.target.value)}
                          placeholder="HMAC signing secret (optional)"
                        />
                      )}
                    </>
                  )}
                  <div>
                    <Button variant="secondary" size="sm" onClick={addDestination}>
                      + Add destination
                    </Button>
                  </div>
                </div>
              )}
            </Field>

            <Field label="Safety limit: at most this many runs per hour">
              <Input
                type="number"
                min="1"
                max="500"
                step="1"
                value={maxPerHour}
                onChange={(e) => setMaxPerHour(Number(e.target.value))}
              />
              <p className="form-copy" style={{ marginTop: 4 }}>
                Fires beyond the limit are skipped (logged as &quot;Rate limit&quot; in the fire log) — a
                misbehaving event source can&apos;t drain your budget.
              </p>
            </Field>

            {/* ---- Review summary ---- */}
            <Card style={{ padding: "12px 14px", marginTop: 8 }}>
              <h4 style={{ marginTop: 0 }}>Review</h4>
              <div style={{ fontSize: "0.85em", display: "grid", gap: 4 }}>
                <div>
                  <strong>{name.trim() || "(unnamed)"}</strong>{" "}
                  {kind !== "other" && <Badge tone="neutral">{kind === "schedule" ? "schedule" : "event"}</Badge>}
                </div>
                <div>When: {triggerSummary}</div>
                <div>
                  Run: <strong>{kits.find((k) => k.kitId === kitSel)?.name ?? entitled.find((k) => marketSelectionValue(k.slug) === kitSel)?.name ?? kitSel}</strong>{" "}
                  under its standing approval
                </div>
                <div>
                  Prompt: <span style={{ color: "var(--color-text-secondary)" }}>{promptTemplate.trim().slice(0, 120)}{promptTemplate.trim().length > 120 ? "…" : ""}</span>
                </div>
                {filters.filter((f) => f.path.trim()).length > 0 && <div>Filters: {filters.filter((f) => f.path.trim()).length} (all must match)</div>}
                <div>Deliver: {destinations.length === 0 ? "no destinations (results stay in run history)" : destinations.map(destinationLabel).join(" · ")}</div>
                <div>Rate limit: at most {maxPerHour}/hour</div>
              </div>
            </Card>
          </>
        )}

        {/* ---- Step nav ---- */}
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          {stepIndex > 0 && (
            <Button variant="secondary" onClick={() => setStep(STEPS[stepIndex - 1])}>
              Back
            </Button>
          )}
          {step !== "deliver" ? (
            <Button onClick={nextStep}>Next</Button>
          ) : (
            <Button disabled={busy} loading={busy} onClick={() => void submit()}>
              {busy ? "Saving…" : editTrigger ? "Save changes" : "Create automation"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
