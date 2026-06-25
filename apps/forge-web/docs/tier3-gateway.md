# Tier-3 Kit Gateway — client-agnostic design stub (Phase 4)

> Status: **DESIGN ONLY — deferred behind AgentKitAuto.** This file locks the
> contract shape so the gateway is NOT built web-only and retrofitted later.
> No gateway is implemented yet.

## Why Tier-3 lives in the backend, not a client

Tier-2 protection (online-only kits) keeps a paid kit's bytes from being
*persisted*, but the buyer's client still receives the content. **Tier-3** is the
only model where the buyer never sees the kit text at all: the secret kit
instructions are injected **server-side** into the model call. Because the
content never reaches the client, Tier-3 is **client-agnostic** — desktop Forge,
web Forge, the CLI, and Auto are all just thin front-ends that send user inputs
and render streamed outputs.

Design rule: **the gateway is one backend service; every client consumes the
same API.** Do not couple it to the web app.

## Auth & economics (fixed constraints)

- The model call MUST use **our** Anthropic key server-side. BYO-key leaks the
  injected prompt via the buyer's own Anthropic console, defeating Tier-3. So
  Tier-3 = we are a metered inference reseller (pass-through model cost + Stripe).
- Per-buyer **entitlement** is checked on every session (reuse the Market
  `EntitlementRepository` / `/admin/kits/{kitId}/entitlements` already shipped).
- Per-buyer budget caps + rate limits to bound our Anthropic spend.

## Endpoint contract (shape only)

All clients call the same gateway, authenticated by the caller's identity
(WorkOS — bearer for desktop/CLI device-auth, cookie-session→forwarded bearer for
web; mirror the existing dual-path pattern). The kit is identified by id; the
client never receives its contents.

```
POST /gateway/sessions            -> { sessionId }        # start a run of kit {kitId} (entitlement-checked)
POST /gateway/sessions/{id}/turn  -> streamed events      # send user input; server injects secret prompt, calls model
POST /gateway/sessions/{id}/tool-result -> streamed events # return a locally-executed tool result (see below)
DELETE /gateway/sessions/{id}                              # end session
```

The injected kit prompt is cached server-side (Anthropic prompt caching) so the
per-turn overhead of a large kit prompt is cheap.

## "Remote brain, local hands" (the local-file case)

Pure server-side execution can't touch a user's local files. For kits that must
operate on local files/tools (e.g. a coding-agent kit), split execution:

1. Model + secret instructions run **server-side** (injected each turn, cached).
2. The model emits **tool calls**; the gateway streams them to the client.
3. The **client executes them locally** (read/write files, run commands) and
   returns results via `/tool-result`.

Only tool-call requests/results cross the wire — they reveal *behavior*, never
the full instructions. The secret prompt never leaves the backend. This is also
the natural Auto runtime architecture, which is why Tier-3 should converge with
Auto rather than ship as a separate web-only feature.

## What must NOT be assumed

- No assumption of a browser. The gateway speaks plain authenticated HTTP +
  streaming; the desktop native client (with local-hands tool execution) is a
  first-class consumer, arguably the better one for local-file kits.
- No persisting kit content to any client-visible store.

## Open items (when Auto lands)

- Pick the streaming transport (SSE / chunked) consistent with Auto.
- Define the tool-call/result envelope (align with Auto's tool protocol).
- Stripe metered billing + budget-cap enforcement.
- Residual leak mitigation (prompt-extraction guards; per-buyer watermark on
  outputs where feasible) — accept inference attacks are imperfectly preventable.
