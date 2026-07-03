"use client";

// The AUTOMATIONS section — the unified Trigger surface (contracts:
// auto-events.ts). One automation = (what starts it) × (kit to run) ×
// (prompt mapping) × (destinations), created through the guided
// When → Run → Deliver wizard (TriggerWizard).
//
// This section renders:
//   • the automations LIST (type badge, kit, enabled toggle, lastFired/
//     fireCount, circuit-paused indicator + Resume, edit/delete/test-fire/
//     fire-log actions);
//   • the FIRE LOG panel (plain-language outcome labels — observability, not
//     fake runs);
//   • EVENT SOURCES + the event INSPECTOR (recent events → payload → replay),
//     with one-time token handling on create/rotate;
//   • the TEST FIRE dialog (sample = a stored event or pasted JSON);
//   • the ?template= deep link (Market "use this automation") → wizard
//     prefilled (lib/automations/template-link).
//
// The legacy Schedules and Triggers (webhooks) sections remain untouched;
// this is the new unified surface alongside them.
import { useCallback, useEffect, useState } from "react";
import { Badge, BRAND_ACCENTS, Button, Card, Field, Input, Pill, Select, Textarea, brandVars } from "@agentkitforge/ui";
import type {
  AutoApproval,
  PublicEventSource,
  ReceivedEvent,
  Trigger,
  TriggerFireLog
} from "@agentkitforge/contracts";
import { autoRoutes } from "@agentkitforge/contracts";
import type { MyKitEntry, Notify } from "../shared";
import { errMsg } from "../shared";
import { ClientTime } from "../ClientTime";
import type { EntitledKit } from "../market-kit-ref";
import {
  deleteEventSource,
  deleteTrigger,
  listEventSources,
  listSourceEvents,
  listTriggerFireLogs,
  listTriggers,
  replayEvent,
  resumeTrigger,
  rotateEventSourceToken,
  testFireTrigger,
  updateEventSource,
  updateTrigger
} from "@/lib/automations/client";
import { fireOutcomeLabel, fireOutcomeTone } from "@/lib/automations/fire-log";
import { decodeTemplateParam } from "@/lib/automations/template-link";
import { TriggerWizard, type WizardInitial } from "./TriggerWizard";

const AUTO_GREEN = BRAND_ACCENTS.auto.accent;
const AUTO_GREEN_STRONG = BRAND_ACCENTS.auto.strong;

/** Rough on-the-wire size of an event payload, for the events table. */
function payloadSize(payload: unknown): string {
  try {
    const bytes = new Blob([JSON.stringify(payload) ?? ""]).size;
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  } catch {
    return "—";
  }
}

async function jsonFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

const TRIGGER_TYPE_LABELS: Record<Trigger["type"], string> = {
  schedule: "Schedule",
  event: "Event",
  watch: "File watch",
  rss: "RSS",
  run_completed: "Run chain",
  email_in: "Email",
  message: "Message"
};

export function AutomationsSection({
  kits,
  notify,
  marketEnabled
}: {
  kits: MyKitEntry[];
  notify: Notify;
  marketEnabled?: boolean;
}) {
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [sources, setSources] = useState<PublicEventSource[]>([]);
  const [approvals, setApprovals] = useState<AutoApproval[]>([]);
  const [entitled, setEntitled] = useState<EntitledKit[]>([]);

  // Wizard (create / edit / template-prefilled). Null = list view.
  const [wizard, setWizard] = useState<WizardInitial | null>(null);

  // Right-panel context: fire log or the event inspector (source detail).
  const [fireLog, setFireLog] = useState<{ trigger: Trigger; logs: TriggerFireLog[] } | null>(null);
  const [inspect, setInspect] = useState<{ source: PublicEventSource; events: ReceivedEvent[] } | null>(null);
  const [openEventId, setOpenEventId] = useState<string | null>(null);

  // One-time token display after rotate (create shows it inside the wizard).
  const [rotated, setRotated] = useState<{ sourceName: string; token: string } | null>(null);

  // Test-fire dialog.
  const [testFire, setTestFire] = useState<{
    trigger: Trigger;
    events: ReceivedEvent[];
    choice: string; // event id, or "" = paste
    pasted: string;
    busy: boolean;
  } | null>(null);

  const loadTriggers = useCallback(async () => {
    try {
      setTriggers(await listTriggers());
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify]);

  const loadSources = useCallback(async () => {
    try {
      setSources(await listEventSources());
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify]);

  const loadApprovals = useCallback(async () => {
    try {
      const { approvals: list } = await jsonFetch<{ approvals: AutoApproval[] }>(autoRoutes.approvals());
      setApprovals(list.filter((a) => a.revokedAt === null));
    } catch (e) {
      notify(errMsg(e), true);
    }
  }, [notify]);

  // Entitled protected Market kits for the wizard's kit picker (same fail-closed
  // gating as AutoSection: never called on a Market-disabled self-host).
  const loadEntitled = useCallback(async () => {
    if (!marketEnabled) return;
    try {
      const { kits: list } = await jsonFetch<{ kits: EntitledKit[] }>("/api/auto/entitled-kits");
      setEntitled(Array.isArray(list) ? list : []);
    } catch {
      /* non-fatal — picker just omits Market kits */
    }
  }, [marketEnabled]);

  useEffect(() => {
    void loadTriggers();
    void loadSources();
    void loadApprovals();
    void loadEntitled();
  }, [loadTriggers, loadSources, loadApprovals, loadEntitled]);

  // ---- ?template= deep link (Market → prefilled wizard). Read once, then
  // stripped so a refresh doesn't re-open the wizard. Garbage decodes to null
  // and is silently ignored (the param is still stripped).
  const [templateApplied, setTemplateApplied] = useState(false);
  useEffect(() => {
    if (templateApplied || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("template");
    if (!raw) return;
    setTemplateApplied(true);
    const template = decodeTemplateParam(raw);
    if (template) {
      setWizard({ mode: "create", template });
      notify(`Loaded automation template "${template.name}" — review and create.`);
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("template");
    window.history.replaceState({}, "", url.toString());
  }, [templateApplied, notify]);

  // ---- ?connection=created — return leg of an OAuth folder connect started in
  // the watch wizard. Re-open the wizard on the watch step (it restores the
  // saved draft from sessionStorage + selects the newly-created connection).
  // Read once, then strip the param so a refresh doesn't re-open the wizard.
  const [connectionRestored, setConnectionRestored] = useState(false);
  useEffect(() => {
    if (connectionRestored || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("connection") !== "created") return;
    setConnectionRestored(true);
    setWizard({ mode: "create", restoreWatchDraft: true });
    const url = new URL(window.location.href);
    url.searchParams.delete("connection");
    window.history.replaceState({}, "", url.toString());
  }, [connectionRestored]);

  // ---- trigger row actions ----
  const toggleTrigger = async (t: Trigger) => {
    try {
      await updateTrigger(t.id, { enabled: !t.enabled });
      await loadTriggers();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const removeTrigger = async (id: string) => {
    try {
      await deleteTrigger(id);
      notify("Automation deleted.");
      if (fireLog?.trigger.id === id) setFireLog(null);
      await loadTriggers();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const resume = async (t: Trigger) => {
    try {
      await resumeTrigger(t.id);
      notify("Automation resumed.");
      await loadTriggers();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const openFireLog = async (t: Trigger) => {
    try {
      const logs = await listTriggerFireLogs(t.id);
      setInspect(null);
      setFireLog({ trigger: t, logs });
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const openTestFire = async (t: Trigger) => {
    let events: ReceivedEvent[] = [];
    if (t.type === "event") {
      try {
        events = await listSourceEvents(t.config.sourceId);
      } catch {
        /* fall through — paste JSON still works */
      }
    }
    setTestFire({ trigger: t, events, choice: events[0]?.id ?? "", pasted: "", busy: false });
  };

  const runTestFire = async () => {
    if (!testFire) return;
    let sample: unknown;
    if (testFire.choice) {
      sample = testFire.events.find((e) => e.id === testFire.choice)?.payload;
    } else if (testFire.pasted.trim()) {
      try {
        sample = JSON.parse(testFire.pasted);
      } catch {
        return notify("The pasted sample isn't valid JSON.", true);
      }
    }
    setTestFire({ ...testFire, busy: true });
    try {
      const res = await testFireTrigger(testFire.trigger.id, sample);
      notify(`Test fire: ${fireOutcomeLabel(res.fireLog.outcome)}${res.fireLog.detail ? ` — ${res.fireLog.detail}` : ""}`);
      setTestFire(null);
      await loadTriggers();
      if (fireLog?.trigger.id === testFire.trigger.id) void openFireLog(testFire.trigger);
    } catch (e) {
      notify(errMsg(e), true);
      setTestFire((prev) => (prev ? { ...prev, busy: false } : prev));
    }
  };

  // ---- event-source actions ----
  const openInspector = async (s: PublicEventSource) => {
    try {
      const events = await listSourceEvents(s.id);
      setFireLog(null);
      setOpenEventId(null);
      setInspect({ source: s, events });
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const toggleSource = async (s: PublicEventSource) => {
    try {
      await updateEventSource(s.id, { enabled: !s.enabled });
      await loadSources();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const rotate = async (s: PublicEventSource) => {
    try {
      const res = await rotateEventSourceToken(s.id);
      setRotated({ sourceName: s.name, token: res.token });
      notify("Token rotated. Copy the new token now — the old one no longer works.");
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const removeSource = async (s: PublicEventSource) => {
    try {
      await deleteEventSource(s.id);
      notify("Event source deleted.");
      if (inspect?.source.id === s.id) setInspect(null);
      await loadSources();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const replay = async (sourceId: string, eventId: string) => {
    try {
      await replayEvent(sourceId, eventId);
      notify("Event replayed — its triggers were re-evaluated (see fire logs).");
      await loadTriggers();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  // Label a kitRef with the same local/Market resolution the other panes use.
  const kitRefLabel = (ref: Trigger["kitRef"]): string => {
    if (ref.source === "market") {
      const kit = ref.slug ? entitled.find((k) => k.slug === ref.slug) : undefined;
      return kit ? `${kit.name} (Market)` : `${ref.slug ?? ref.marketKitId ?? "kit"} (Market)`;
    }
    return kits.find((k) => k.kitId === ref.localKitId)?.name ?? ref.localKitId ?? "(unknown kit)";
  };

  // ---- wizard takes over the whole pane ----
  if (wizard) {
    return (
      <div style={brandVars(AUTO_GREEN, AUTO_GREEN_STRONG)}>
        <TriggerWizard
          initial={wizard}
          kits={kits}
          entitled={entitled}
          approvals={approvals}
          sources={sources}
          triggers={triggers}
          notify={notify}
          onSourcesChanged={loadSources}
          onDone={(changed) => {
            setWizard(null);
            if (changed) void loadTriggers();
          }}
        />
      </div>
    );
  }

  const openEvent = inspect?.events.find((e) => e.id === openEventId);

  return (
    <div style={brandVars(AUTO_GREEN, AUTO_GREEN_STRONG)}>
      <div className="form-layout">
        {/* ================= Automations list ================= */}
        <div className="form-panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <h3 style={{ margin: 0 }}>Automations</h3>
            <Button onClick={() => setWizard({ mode: "create" })}>New automation</Button>
          </div>
          <p className="form-copy">
            An automation runs a kit for you — on a schedule or when an event arrives — under a standing
            approval, a per-run budget, and a rate limit. It never widens consent.
          </p>
          {triggers.length === 0 ? (
            <p className="form-copy">No automations yet. Create one — it takes three quick steps.</p>
          ) : (
            triggers.map((t) => {
              const paused = Boolean(t.circuit?.pausedAt);
              return (
                <div key={t.id} className="provider-card" style={{ marginBottom: 8, padding: "8px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontSize: "0.85em", minWidth: 0 }}>
                      <strong>{t.name}</strong> <Badge tone="neutral">{TRIGGER_TYPE_LABELS[t.type]}</Badge>{" "}
                      {paused && <Badge tone="error">paused — repeated failures</Badge>}
                      <div style={{ color: "var(--color-text-secondary)" }}>
                        {kitRefLabel(t.kitRef)} · fired {t.fireCount}× · last{" "}
                        <ClientTime ts={t.lastFiredAt ?? null} />
                      </div>
                      {t.lastError && <div style={{ color: "var(--color-error)" }}>last error: {t.lastError}</div>}
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {paused && (
                        <Button size="sm" onClick={() => void resume(t)}>
                          Resume
                        </Button>
                      )}
                      <label style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 400, fontSize: "0.8em" }}>
                        <input type="checkbox" checked={t.enabled} onChange={() => void toggleTrigger(t)} />
                        {t.enabled ? "on" : "off"}
                      </label>
                      <Button variant="secondary" size="sm" onClick={() => setWizard({ mode: "edit", trigger: t })}>
                        Edit
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => void openTestFire(t)}>
                        Test fire
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => void openFireLog(t)}>
                        Fire log
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => void removeTrigger(t.id)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {/* ---- Test-fire dialog (inline card) ---- */}
          {testFire && (
            <Card style={{ marginTop: 12, padding: "12px 14px" }}>
              <h4 style={{ marginTop: 0 }}>Test fire &quot;{testFire.trigger.name}&quot;</h4>
              <p className="form-copy">
                Runs the trigger once with a sample event (filters, rate limit, and budget checks all apply
                — exactly like a real fire).
              </p>
              {testFire.events.length > 0 && (
                <Field label="Sample event">
                  <Select
                    value={testFire.choice}
                    onChange={(e) => setTestFire({ ...testFire, choice: e.target.value })}
                  >
                    {testFire.events.map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.name} · {new Date(ev.receivedAt).toLocaleString()}
                      </option>
                    ))}
                    <option value="">Paste JSON instead…</option>
                  </Select>
                </Field>
              )}
              {(testFire.events.length === 0 || testFire.choice === "") && (
                <Field label="Sample payload (JSON, optional)">
                  <Textarea
                    rows={4}
                    value={testFire.pasted}
                    onChange={(e) => setTestFire({ ...testFire, pasted: e.target.value })}
                    placeholder='{"example": "payload"}'
                  />
                </Field>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <Button disabled={testFire.busy} loading={testFire.busy} onClick={() => void runTestFire()}>
                  {testFire.busy ? "Firing…" : "Fire now"}
                </Button>
                <Button variant="secondary" onClick={() => setTestFire(null)}>
                  Cancel
                </Button>
              </div>
            </Card>
          )}
        </div>

        {/* ================= Right panel: fire log / inspector / sources ================= */}
        <div className="results-panel">
          {/* ---- one-time rotated token ---- */}
          {rotated && (
            <Card style={{ marginBottom: 12, padding: "12px 14px" }}>
              <h4 style={{ marginTop: 0 }}>New token for &quot;{rotated.sourceName}&quot;</h4>
              <p className="form-copy">
                Shown <strong>only once</strong> — you won&apos;t see it again. Update every service that
                posts to this source.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <Input type="text" readOnly value={rotated.token} onFocus={(e) => e.currentTarget.select()} />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(rotated.token);
                    notify("Token copied.");
                  }}
                >
                  Copy
                </Button>
              </div>
              <Button variant="secondary" size="sm" style={{ marginTop: 8 }} onClick={() => setRotated(null)}>
                I&apos;ve copied it
              </Button>
            </Card>
          )}

          {/* ---- fire log ---- */}
          {fireLog ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <h4 style={{ margin: 0 }}>Fire log — {fireLog.trigger.name}</h4>
                <Button variant="secondary" size="sm" onClick={() => setFireLog(null)}>
                  Close
                </Button>
              </div>
              <p className="form-copy">
                Every fire attempt, including the ones that intentionally didn&apos;t start a run.
              </p>
              {fireLog.logs.length === 0 ? (
                <p className="form-copy">No fires yet.</p>
              ) : (
                fireLog.logs.map((l) => (
                  <div key={l.id} className="provider-card" style={{ marginBottom: 6, padding: "6px 10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", fontSize: "0.82em" }}>
                      <Badge tone={fireOutcomeTone(l.outcome)}>{fireOutcomeLabel(l.outcome)}</Badge>
                      <span style={{ color: "var(--color-text-secondary)" }}>
                        <ClientTime ts={l.at} />
                      </span>
                    </div>
                    {(l.detail || l.runId) && (
                      <div style={{ fontSize: "0.78em", color: "var(--color-text-secondary)", marginTop: 2 }}>
                        {l.detail}
                        {l.runId ? (l.detail ? " · " : "") + `run ${l.runId}` : ""}
                      </div>
                    )}
                  </div>
                ))
              )}
            </>
          ) : inspect ? (
            /* ---- event inspector ---- */
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <h4 style={{ margin: 0 }}>Events — {inspect.source.name}</h4>
                <Button variant="secondary" size="sm" onClick={() => setInspect(null)}>
                  Close
                </Button>
              </div>
              <p className="form-copy" style={{ wordBreak: "break-all" }}>
                Emit URL base: <code>{inspect.source.ingestUrl}</code>
              </p>
              {inspect.events.length === 0 ? (
                <p className="form-copy">No events received yet.</p>
              ) : (
                inspect.events.map((ev) => (
                  <div key={ev.id} className="provider-card" style={{ marginBottom: 6, padding: "6px 10px" }}>
                    <div
                      style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", cursor: "pointer", fontSize: "0.82em" }}
                      onClick={() => setOpenEventId(openEventId === ev.id ? null : ev.id)}
                    >
                      <strong>{ev.name}</strong>
                      <span style={{ color: "var(--color-text-secondary)" }}>
                        <ClientTime ts={ev.receivedAt} /> · {payloadSize(ev.payload)}
                      </span>
                    </div>
                    {openEventId === ev.id && (
                      <>
                        <pre className="json-panel" style={{ whiteSpace: "pre-wrap", maxHeight: 220, marginTop: 6, fontSize: "0.78em" }}>
                          {JSON.stringify(ev.payload, null, 2)}
                        </pre>
                        <Button variant="secondary" size="sm" onClick={() => void replay(inspect.source.id, ev.id)}>
                          Replay this event
                        </Button>
                      </>
                    )}
                  </div>
                ))
              )}
            </>
          ) : (
            /* ---- event sources list (default right panel) ---- */
            <>
              <h4 style={{ marginTop: 0 }}>Event sources</h4>
              <p className="form-copy">
                An event source is your personal inbox URL for events (from Zapier, GitHub, curl, anything).
                Create one inside the wizard; inspect its recent events here.
              </p>
              {sources.length === 0 ? (
                <p className="form-copy">No event sources yet.</p>
              ) : (
                sources.map((s) => (
                  <div key={s.id} className="provider-card" style={{ marginBottom: 8, padding: "8px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ fontSize: "0.85em", minWidth: 0 }}>
                        <strong>{s.name}</strong>{" "}
                        {s.provider && <Pill tone="brand">{s.provider}</Pill>}{" "}
                        {s.hasSigningSecret && <Pill tone="neutral">signed</Pill>}
                        <div style={{ color: "var(--color-text-secondary)" }}>
                          {s.eventCount} events · last <ClientTime ts={s.lastEventAt ?? null} />
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 400, fontSize: "0.8em" }}>
                          <input type="checkbox" checked={s.enabled} onChange={() => void toggleSource(s)} />
                          {s.enabled ? "on" : "off"}
                        </label>
                        <Button variant="secondary" size="sm" onClick={() => void openInspector(s)}>
                          Events
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => void rotate(s)}>
                          Rotate token
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => void removeSource(s)}>
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
