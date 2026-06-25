# AgentKitAuto — Run-Execution Plan (hosted DOKS)

Status: **setup-only / "skip runs" today → wiring real EXECUTION.** This document
maps the end-to-end run lifecycle, names exactly what is already built vs. inert,
and lists the increments (code + chart + secrets) needed to make the **hosted DOKS**
deployment actually execute scheduled / triggered / on-demand Auto runs against
Anthropic.

> Scope note: this is the HOSTED product on DOKS (`ns agentkit`,
> `auto.agentkitproject.com`). Auth = WorkOS, billing = **managed**, storage =
> **selfhost backend** (DO Managed Postgres + AWS/DO Spaces S3), dispatch = one-shot
> **k8s Jobs** in `ns agentkit`. This is NOT the AWS-Amplify/Fargate path (that path
> still exists in code — `auto-fargate-dispatcher.ts` — and is what the old
> `.harvested/amplify-*.env` describes, but DOKS does not use it).

---

## 1. End-to-end run lifecycle

```
                         ┌──────────────────────────────────────────────┐
 TRIGGER                 │  auto-web (Next.js Deployment, ns agentkit)  │
 ───────                 │  ServiceAccount: <release>-web (Job RBAC)    │
  • on-demand  ─────────▶│                                              │
    POST /api/auto/runs  │  server/core/auto.ts                         │
  • schedule (cron)      │    startRun() → approval gate → create run   │
    sweep CronJob ──────▶│      (status "queued") in Postgres           │
    POST /internal/sweep │    → resolveAutoBilling() (managed|byo)      │
  • webhook              │    → dispatcher(runId)  ◀── initAutoDispatcher│
    POST /api/hooks/...  │         = kubeJobDispatcher (AUTO_DISPATCH=k8s)│
                         └───────────────────┬──────────────────────────┘
                                             │ creates batch/v1 Job
                                             ▼
                         ┌──────────────────────────────────────────────┐
 EXECUTION               │  one-shot k8s Job  (auto-worker image)        │
 ─────────               │  ns agentkit, env: RUN_ID + selfhost backend  │
                         │  dist/entrypoints/run-task.js → runTask()     │
                         │   1. fetchResolveContext():                   │
                         │        POST WEB_FORGE_INTERNAL_URL/internal/   │
                         │        auto/resolve-context  (service key)  ──┼──▶ back to auto-web
                         │        ← { systemPrompt, tools, inferenceMode,│    resolveWorkerContext()
                         │            byoProvider? }                     │
                         │   2. processAutoRun(runId, deps):             │
                         │        approval gate (defense in depth)       │
                         │        create workspace on /scratch           │
                         │        runAutoRun():                          │
                         │          managed → runManagedTurn (ledger     │
                         │             hold+settle, Anthropic platform   │
                         │             key, 25% markup)                  │
                         │          byo → chatProvider.sendMessage       │
                         │          tool_use → sandbox executor → loop   │
                         │        deliverResult() (opt-in email/webhook) │
                         │   3. updateRunStatus succeeded|failed|...     │
                         └──────────────────────────────────────────────┘
                                             │ persists status + spend
                                             ▼  (Postgres run row)
 REPORT/STATUS:  GET /api/auto/runs/[id]  (cookie/bearer, ownership-checked)
```

Run status machine (auto-core): `queued → running → succeeded | failed | canceled
| budget_exceeded`. Cancellation is a kill-switch flag the driver polls each turn.

Billing (server-chosen, never client-supplied):
- **managed** (the DOKS default): platform Anthropic key; each turn debits the
  credit ledger via gateway-core `runManagedTurn` at `AUTO_MARKUP_BPS` (25%).
- **byo**: the user's own Anthropic key (resolved from user settings); inference is
  NOT debited. A per-minute cloud-run compute fee may apply (BYO + cloud only).

---

## 2. What is ALREADY built (do not rebuild)

| Piece | File | State |
|---|---|---|
| Autonomous run driver (loop, budget cap, kill-switch, billing reuse) | `packages/auto-core/src/core/run-driver.ts` | ✅ complete, tested |
| Worker orchestrator (approval gate, workspace, executor, delivery) | `packages/auto-core/src/entrypoints/worker.ts` (`processAutoRun`) | ✅ complete, gate tested |
| Worker process main (env wiring, backend select, resolve-context fetch) | `packages/auto-core/src/entrypoints/run-task.ts` (`runTask`/`main`) | ✅ built, **was untested** |
| Worker image | `packages/auto-core/Dockerfile` + `docker-entrypoint.sh` | ✅ builds; entrypoint hardening caveat below |
| k8s Job dispatcher (builds V1Job, hardened securityContext, lazy k8s client) | `apps/auto-web/server/core/auto-kube-dispatcher.ts` | ✅ built, **was untested** |
| Fargate dispatcher (AWS path; not used on DOKS) | `apps/auto-web/server/core/auto-fargate-dispatcher.ts` | ✅ built |
| Dispatcher selection at import | `server/core/auto.ts` `initAutoDispatcher()` | ✅ k8s+selfhost → kube; fargate+aws → fargate |
| Internal resolve-context endpoint (service-key) | `app/api/internal/auto/resolve-context/route.ts` + `resolveWorkerContext()` | ✅ complete |
| Internal sweep endpoint (service-key, per-minute) | `app/api/internal/auto/sweep/route.ts` + `runScheduleSweep()` | ✅ complete, verified live |
| Chart: web Deployment emits `AUTO_DISPATCH=k8s`, `AUTO_K8S_*`, `WEB_FORGE_INTERNAL_URL`, `AUTO_SELFHOST_BILLING`, `ANTHROPIC_API_KEY`, `AUTO_WORKER_SERVICE_KEY` | `deploy/charts/agentkitauto/templates/deployment-web.yaml` | ✅ |
| Chart: RBAC (ServiceAccount + Role + RoleBinding to create Jobs in ns) | `deploy/charts/agentkitauto/templates/auto-rbac.yaml` | ✅ |
| Chart: sweep CronJob | `deploy/charts/agentkitauto/templates/auto-sweep-cronjob.yaml` | ✅ |
| Hosted DOKS overlay (`billing: managed`, external PG+S3) | `agentkitproject-doks-infra/deploy/argocd/values/values-auto.yaml` | ✅ |

**Conclusion:** the dispatch + worker path is structurally COMPLETE for the DOKS
(selfhost-backend + managed-billing + k8s-Job) configuration. The "skip runs" state
is NOT a missing dispatcher — it is the gaps below.

---

## 3. What is MISSING / inert for real execution

### G1 — Worker entrypoint vs. k8s `runAsNonRoot` (HIGH, likely the live blocker)
`docker-entrypoint.sh` was written for the **Fargate** hardening model: start as
root, `chown -R node:node /scratch`, then `exec gosu node`. The k8s Job spec in
`auto-kube-dispatcher.ts` sets `runAsNonRoot: true` + `runAsUser: 1000` +
`capabilities.drop:[ALL]` and relies on `fsGroup` to make `/scratch` group-writable
(no chown needed). Under that pod securityContext the entrypoint runs **as node, not
root**, so:
- `chown -R node:node /scratch` is run by a non-root user → on most kernels this
  **fails** (EPERM) for files it doesn't own; with `set -e` the entrypoint aborts
  and the Job never starts the worker.
- `gosu node` is a redundant no-op (already node) but harmless.

This means a k8s-dispatched worker can crash on boot before `runTask` runs. Fix: make
the entrypoint **skip the chown when not root / when /scratch is already writable**
(it already guards `if [ -d /scratch ]`; tighten to `if running-as-root && -d`).
See increment I2.

### G2 — No automated coverage of the execution path (HIGH)
There is **no** test that exercises: dispatcher builds a correct Job; `runTask`
fetches context + runs `processAutoRun`; a full mocked-Anthropic run reaches
`succeeded` with spend recorded. `server/core/auto.ts` even references a
`test/auto.test.ts` that does not exist. Without this, any wiring regression ships
silently. See increments I1 + I3.

### G3 — `AUTO_INPUTS_BUCKET` / S3 not forwarded to the worker Job env (MEDIUM)
`workerEnv()` forwards `S3_ENDPOINT/S3_BUCKET/S3_PREFIX/S3_ACCESS_KEY_ID/
S3_SECRET_ACCESS_KEY/AWS_REGION` but NOT `AUTO_INPUTS_BUCKET` or
`S3_FORCE_PATH_STYLE`. On DOKS, staged input-file hydration (Phase C) reads from
`AUTO_INPUTS_BUCKET`; without it the worker's selfhost input store falls back and
staged inputs silently won't hydrate. (Runs with no uploaded inputs are unaffected —
hence MEDIUM, not HIGH.) See increment I4.

### G4 — Managed-billing ledger in the worker is commercial-only (EXPECTED, documented)
On DOKS `AUTO_SELFHOST_BILLING=managed`, but auto-core's worker `buildBackendDeps`
**throws** for `selfhost + managed` ("requires @agentkit-commercial/gateway"). So a
real managed run on the worker needs the commercial managed Postgres credit ledger
wired into the worker image/deps, OR the run is effectively BYO on the operator key.
This is the billing seam — NOT built here. Flag for review: decide whether DOKS
managed metering runs through the commercial ledger in the worker, or whether the
hosted launch is BYO-on-platform-key (no per-user metering) for v1. See §6.

### G5 — Worker image tag + ANTHROPIC key are real-spend gates (OPS)
`auto.workerImage` defaults to `:latest`; the DOKS overlay pins the **app** image by
sha but not the **worker** image. And `ANTHROPIC_API_KEY` in the secret is a real
billable key. Both must be set deliberately before enabling runs. See §5.

---

## 4. RBAC (already correct — documented for review)

The web pod's ServiceAccount needs to CREATE Jobs in `ns agentkit`. Provided by
`auto-rbac.yaml`:
- `ServiceAccount <release>-web` (the web Deployment runs under it when `auto.enabled`).
- namespaced `Role` (`batch/jobs: create,get,list,watch,delete` + `pods,pods/log:
  get,list,watch`) — **namespace-scoped, not cluster-wide.**
- `RoleBinding` binding the SA to that Role in `auto.namespace` (= release ns).

No change needed. The worker Jobs themselves need **no** cluster API access (they
only call back over HTTP to the internal resolve endpoint), so leaving
`auto.serviceAccount` empty (namespace default SA) is fine.

---

## 5. Chart / secret / deploy changes the hosted run needs

1. **Pin the worker image** in `values-auto.yaml`:
   `auto.workerImage: ghcr.io/agentkitproject/agentkitauto-worker:sha-<...>` (build it
   from `packages/auto-core/Dockerfile`; it is a separate image from the app).
2. **Secret keys** (in `agentkitauto-web-secret`, already wired via `envFrom`):
   `ANTHROPIC_API_KEY`, `AUTO_WORKER_SERVICE_KEY` (shared by web + sweep + worker),
   `DATABASE_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, WorkOS keys. The worker
   Job re-reads DB/S3/service-key/Anthropic from the web pod's env via the dispatcher's
   `workerEnv()` — so they must be present on the WEB pod (they are).
3. **Forward `AUTO_INPUTS_BUCKET` + `S3_FORCE_PATH_STYLE`** to worker Jobs (increment
   I4) so Phase C staged inputs hydrate on DOKS.
4. **Entrypoint fix (I2)** must ship in the worker image before k8s dispatch works.
5. **Billing decision (G4/§6)** before enabling managed metering.

No new RBAC, no new endpoints, no new tables.

---

## 6. Usage metering / billing seam (NOTE — do not build here)

- The driver already meters: managed turns go through gateway-core `runManagedTurn`,
  which does the two-phase credit hold and settles actual metered cost (+25% markup)
  against a `CreditLedgerRepository`. `recordSpend` persists per-run spend.
- The **ledger implementation** the worker uses is selected in auto-core's
  `buildBackendDeps`: `selfhost + free` → inert free ledger; `selfhost + managed` →
  **throws** (needs `@agentkit-commercial/gateway` `PostgresCreditLedgerRepository`).
- **Seam to wire later:** install/inject the commercial managed Postgres ledger into
  the worker (mirroring how `selectLedger()` in `auto.ts` optionally loads it for the
  in-process path), OR run hosted v1 as BYO-on-platform-key (no per-user debit). This
  is a billing/commercial decision, intentionally out of scope for this increment.

---

## 7. Increments (this PR = I1–I4; later = I5+)

- **I1** (done): unit tests for the **k8s Job dispatcher** (`buildAutoJob` spec shape,
  env forwarding, securityContext) + the **Fargate dispatcher** RunTask input —
  no real cluster/AWS, injected fakes.
- **I2** (done): harden `docker-entrypoint.sh` to skip the root-only chown when not
  running as root (fixes G1 so k8s `runAsNonRoot` workers boot).
- **I3** (done): end-to-end **worker** test — `runTask` with an injected
  resolve-context fetch + a MOCKED Anthropic ChatProvider, asserting a full run
  reaches `succeeded` with spend recorded and NO real inference.
- **I4** (done): forward `AUTO_INPUTS_BUCKET` + `S3_FORCE_PATH_STYLE` in the kube
  dispatcher `workerEnv()` (G3).
- **I5** (review/ops): pin worker image, decide managed-ledger seam (G4), real smoke
  on a kind/k3s cluster with a single minimal prompt (flag spend).
