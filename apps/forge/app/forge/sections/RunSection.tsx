"use client";

// Run / Chat with a kit using MANAGED AI (Gateway Phase 2b).
//
// Pick an owned kit + a managed model (default Sonnet 4.6), see the credit
// balance, type a prompt, and watch the assistant reply stream in live. Each
// message reuses the same gateway session so the conversation has memory; the
// session is cleaned up on unmount or when you start a new chat.
//
// CONVERSATIONAL-ONLY: the web client does not execute tools this pass (see
// WebForgeClient.runAgentKitWithAi). A 402 insufficient-credits response surfaces
// the existing inline top-up affordance.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Field, Select, Textarea } from "@agentkitforge/ui";
import type { Forge, MyKitEntry, Notify } from "./shared";
import { errMsg } from "./shared";
import { HttpError } from "@/forge-client";
import type { GatewayStreamEvent } from "@/forge-client";
import { CreditsPanel, InsufficientCreditsBanner, fetchCredits, type Credits } from "./CreditsPanel";
import { useConfig } from "../config-context";
import {
  isMarketSelection,
  marketSelectionValue,
  parseMarketDeepLink,
  resolveMarketSelection,
  type EntitledKit
} from "./market-kit-ref";

type ManagedModel = { id: string; label: string; tier: string };
type ChatMessage = { role: "user" | "assistant"; text: string; streaming?: boolean };
type CreditsError = { message: string; requiredCents?: number; balanceCents?: number };

export function RunSection({
  forge,
  kits,
  notify,
  initialMarketSlug
}: {
  forge: Forge;
  kits: MyKitEntry[];
  notify: Notify;
  /** Deep-link target: a `market:<slug>` slug to preselect + run (output-only kit). */
  initialMarketSlug?: string | null;
}) {
  const { creditsEnabled, marketEnabled } = useConfig();
  // The selected kit: a local kit id, or `market:<slug>` for a protected Market kit.
  const [kitId, setKitId] = useState<string>("");
  const [entitled, setEntitled] = useState<EntitledKit[]>([]);
  const [models, setModels] = useState<ManagedModel[]>([]);
  const [model, setModel] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [credits, setCredits] = useState<Credits | null>(null);
  const [creditsError, setCreditsError] = useState<CreditsError | null>(null);

  // The active gateway session id — reused across turns; cleaned up on reset/unmount.
  const sessionIdRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const loadCredits = useCallback(async () => {
    setCredits(await fetchCredits().catch(() => null));
  }, []);

  // Load the managed model catalog + credit balance once.
  useEffect(() => {
    void fetch("/api/managed/models", { credentials: "include" })
      .then((r) => r.json())
      .then((res: { models?: ManagedModel[]; defaultModel?: string }) => {
        setModels(res.models ?? []);
        setModel(res.defaultModel ?? res.models?.[0]?.id ?? "");
      })
      .catch(() => {/* selector stays empty; default applied server-side */});
    void loadCredits();
  }, [loadCredits]);

  // Load the user's PROTECTED entitled Market kits (output-only kits that run
  // server-side). Browser-safe: the list is only { marketKitId, slug, name } —
  // never kit content. Fails closed to [] (Market disabled / service error →
  // the run discovery list is simply absent).
  useEffect(() => {
    if (!marketEnabled) return;
    void fetch("/api/forge/entitled-kits", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { kits: [] }))
      .then((res: { kits?: EntitledKit[] }) => setEntitled(res.kits ?? []))
      .catch(() => {/* fail closed — no protected-run list */});
  }, [marketEnabled]);

  // End the gateway session on unmount.
  useEffect(() => {
    return () => {
      const sid = sessionIdRef.current;
      if (sid && forge.endAgentKitSession) void forge.endAgentKitSession(sid);
    };
  }, [forge]);

  // Auto-scroll the transcript as it streams.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Reset the conversation (and end the server session) when the kit changes.
  const resetSession = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid && forge.endAgentKitSession) void forge.endAgentKitSession(sid);
    sessionIdRef.current = null;
    setMessages([]);
  }, [forge]);

  const onKitChange = (id: string) => {
    resetSession();
    setKitId(id);
  };

  // Deep-link: a `?kit=market:<slug>` link from Market preselects the protected
  // kit once it's confirmed to be one of the user's entitled kits (a stale link
  // for an un-owned slug is ignored; the run is also entitlement-gated server-
  // side). Runs after the entitled list resolves.
  useEffect(() => {
    const slug = parseMarketDeepLink(initialMarketSlug);
    if (!slug) return;
    const value = marketSelectionValue(slug);
    if (resolveMarketSelection(value, entitled)) {
      resetSession();
      setKitId(value);
    }
  }, [initialMarketSlug, entitled, resetSession]);

  const send = async () => {
    const text = prompt.trim();
    if (!kitId || !text || busy) return;
    // Resolve a protected Market selection to its slug + id (browser-safe).
    const marketRef = isMarketSelection(kitId) ? resolveMarketSelection(kitId, entitled) : null;
    setCreditsError(null);
    setPrompt("");
    setBusy(true);

    // Optimistically append the user message + an empty streaming assistant slot.
    setMessages((m) => [...m, { role: "user", text }, { role: "assistant", text: "", streaming: true }]);

    const onEvent = (ev: GatewayStreamEvent) => {
      if (ev.type === "text") {
        setMessages((m) => {
          const next = [...m];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") next[next.length - 1] = { ...last, text: last.text + ev.delta };
          return next;
        });
      }
    };

    try {
      const result = (await forge.runAgentKitWithAi({
        // Protected Market kit → keyed by slug (server fetches content); local
        // kit → keyed by kitId. The browser never sends protected kit content.
        ...(marketRef
          ? { marketSlug: marketRef.slug, marketKitId: marketRef.marketKitId }
          : { kitId }),
        prompt: text,
        ...(model ? { model } : {}),
        ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}),
        onEvent
      })) as { sessionId?: string; text?: string };
      if (result.sessionId) sessionIdRef.current = result.sessionId;
      // Finalize the streaming slot (covers non-streaming fallbacks too).
      setMessages((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = { role: "assistant", text: last.text || result.text || "" };
        }
        return next;
      });
      void loadCredits();
    } catch (e) {
      // Drop the empty streaming assistant slot on error.
      setMessages((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last && last.role === "assistant" && last.streaming && !last.text) next.pop();
        return next;
      });
      if (e instanceof HttpError && e.status === 402) {
        const body = e.body as { message?: string; requiredCents?: number; balanceCents?: number } | undefined;
        setCreditsError({
          message: body?.message ?? e.message,
          requiredCents: body?.requiredCents,
          balanceCents: body?.balanceCents
        });
      } else {
        notify(errMsg(e), true);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="use-screen">
      <div className="form-layout">
        <div className="form-panel">
          <h2>Chat with a kit</h2>
          <p className="form-copy">
            Pick one of your kits and talk to it. The kit&apos;s instructions become the assistant&apos;s system
            prompt; replies stream live and are billed to your prepaid credits.
          </p>

          {creditsEnabled && <CreditsPanel notify={notify} />}

          <Field label="Kit">
            <Select value={kitId} onChange={(e) => onKitChange(e.target.value)}>
              <option value="">Select a kit…</option>
              {kits.length > 0 && (
                <optgroup label="Your kits">
                  {kits.map((k) => (
                    <option key={k.kitId} value={k.kitId}>{k.name ?? k.kitId}</option>
                  ))}
                </optgroup>
              )}
              {entitled.length > 0 && (
                <optgroup label="Protected kits (run online)">
                  {entitled.map((k) => (
                    <option key={k.marketKitId} value={marketSelectionValue(k.slug)}>
                      {k.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>

          {entitled.length > 0 && (
            <div className="results-panel" style={{ marginTop: 4, marginBottom: 4 }}>
              <strong>Your protected kits — run online</strong>
              <p className="form-copy" style={{ marginTop: 2 }}>
                These output-only kits run server-side — their contents never leave the server. Pick one to
                use it interactively here.
              </p>
              <div className="button-row" style={{ flexWrap: "wrap" }}>
                {entitled.map((k) => {
                  const value = marketSelectionValue(k.slug);
                  return (
                    <Button
                      key={k.marketKitId}
                      variant={kitId === value ? "primary" : "secondary"}
                      disabled={busy}
                      onClick={() => onKitChange(value)}
                    >
                      Run {k.name}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          <Field label="Model">
            <Select value={model} onChange={(e) => setModel(e.target.value)} disabled={!models.length}>
              {models.length === 0 && <option value="">Default</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </Select>
          </Field>

          <Field label="Message">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send();
              }}
              placeholder="Ask the kit to do something…  (⌘/Ctrl + Enter to send)"
              style={{ minHeight: 100 }}
              disabled={!kitId || busy}
            />
          </Field>

          <div className="button-row" style={{ marginTop: 4 }}>
            <Button disabled={!kitId || !prompt.trim() || busy} loading={busy} onClick={() => void send()}>
              {busy ? "Generating…" : "Send"}
            </Button>
            {messages.length > 0 && (
              <Button variant="secondary" disabled={busy} onClick={resetSession}>
                New chat
              </Button>
            )}
          </div>

          {creditsError && (
            <InsufficientCreditsBanner
              message={creditsError.message}
              requiredCents={creditsError.requiredCents}
              balanceCents={creditsError.balanceCents ?? credits?.balanceCents}
              notify={notify}
            />
          )}
        </div>

        <div className="results-panel">
          <h2 style={{ marginTop: 0 }}>Transcript</h2>
          <div
            ref={transcriptRef}
            style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: "60vh", overflowY: "auto" }}
          >
            {messages.length === 0 ? (
              <p>Pick a kit and send a message to start chatting.</p>
            ) : (
              messages.map((msg, i) => (
                <div
                  key={i}
                  className="provider-card"
                  style={{
                    padding: "8px 12px",
                    background:
                      msg.role === "user" ? "var(--color-surface-2, transparent)" : "var(--color-surface, transparent)"
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.72em",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color: "var(--color-text-secondary)",
                      marginBottom: 4
                    }}
                  >
                    {msg.role === "user" ? "You" : "Kit"}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", fontSize: "0.92em" }}>
                    {msg.text}
                    {msg.streaming && !msg.text && <span style={{ opacity: 0.5 }}>…</span>}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
