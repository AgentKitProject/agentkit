# Self-host AgentKitAuto (Phase D)

Run **AgentKitAuto** — on-demand and scheduled autonomous Agent Kit runs — on
**your own Kubernetes cluster**. This is the self-host equivalent of the hosted
Fargate worker: each Auto run executes in a one-shot Kubernetes **Job** running
the Auto **worker image**, using the same `KITSTORE_BACKEND=selfhost` Postgres +
MinIO backend as the rest of the self-host web app.

Auto is **opt-in** and **off by default**. The self-host web app (kit create /
edit / validate / package / import / export, the interactive gateway) works
without it.

## Architecture

```
                 ┌────────────────────────────────────────────┐
  user / API ──▶ │  agentkitforge-web (Next.js, selfhost)      │
                 │   server/core/auto.ts → kubeJobDispatcher   │
                 └───────────────┬──────────────┬──────────────┘
                                 │ creates Job   │ /api/internal/auto/sweep
                                 ▼               ▲ (per-minute CronJob)
                 ┌────────────────────────────┐ │
                 │  Kubernetes Job (per run)   │ │
                 │   Auto worker image         │ │
                 │   AUTO_BACKEND=selfhost     │ │ re-fetches kit context over
                 │   /scratch emptyDir         │─┘ the service-key resolve endpoint
                 └──────────┬──────────────────┘
                            ▼
              Postgres (auto_*) + MinIO (kit trees, inputs)
```

- **Dispatch**: `AUTO_DISPATCH=k8s` makes the web app create a Job per run
  (`server/core/auto-kube-dispatcher.ts`) instead of running in-process. The
  dispatcher builds the full Job spec (image, env, resources, hardened
  `securityContext`) — only `RUN_ID` is per-run; all other config is forwarded
  from the web pod's own env.
- **Worker**: the same image as Fargate. Its entrypoint
  (`agentkitauto-core/src/entrypoints/run-task.ts`) selects the **self-host
  backend** when `AUTO_BACKEND=selfhost` (or `KITSTORE_BACKEND=selfhost`):
  Postgres storage + `FsWorkspaceStore` on the mounted scratch dir + the
  self-host email sender + (per policy) the free or managed credit ledger.
- **Schedules**: a per-minute **CronJob** POSTs the service key to
  `/api/internal/auto/sweep`, the self-host equivalent of the hosted EventBridge
  rule. Due schedules are dispatched as runs (each becomes its own Job).
- **Security**: the bearer token and any BYO key are **never** placed in a Job's
  env. The worker re-fetches kit context over the service-key-authenticated
  internal resolve endpoint. Jobs run hardened: `runAsNonRoot`, dropped `ALL`
  capabilities, `readOnlyRootFilesystem`, and only a `/scratch` emptyDir is
  writable — `fsGroup` lets the `node` user write it without any chown, so **no**
  `CHOWN/SETUID/SETGID` capabilities are added back.

## Billing policy (self-host)

Set `auto.billing`:

| Policy | Inference | Compute fee | Ledger |
|---|---|---|---|
| `free` (default) | BYO (operator's `ANTHROPIC_API_KEY`); not metered | none | inert (no-op) |
| `managed` | platform key, metered at `AUTO_MARKUP_BPS` | per-minute (`AUTO_CLOUD_RUN_CENTS_PER_MIN`) | gateway-core Postgres credit ledger |

Most self-hosters want **free**: supply one `ANTHROPIC_API_KEY` and every run is
BYO with no metering. Only choose `managed` if you operate a credit/top-up flow.
`managed` sets the dispatcher's `isCloudRun=true` so the metered compute fee
applies; `free` leaves it `false`.

## 1. Build (or pull) the worker image

The worker image is built from `agentkitauto-core/Dockerfile`. Because auto-core
links `@agentkitforge/gateway-core` via a sibling `file:` dependency, build from
the **parent workspace dir** that contains both repos:

```sh
docker build -f agentkitauto-core/Dockerfile \
  -t ghcr.io/agentkitproject/agentkitauto-worker:<tag> \
  <workspaceRoot>           # the dir containing agentkitauto-core/ + agentkitgateway-core/
docker push ghcr.io/agentkitproject/agentkitauto-worker:<tag>
```

The **same** image runs hosted (Fargate, DynamoDB) and self-host (k8s Job,
Postgres) — the backend is chosen at runtime by `AUTO_BACKEND`.

## 2. Enable Auto in the Helm chart

In your values (or `--set`):

```yaml
auto:
  enabled: true
  workerImage: "ghcr.io/agentkitproject/agentkitauto-worker:<tag>"
  billing: "free"                 # or "managed"
  anthropicApiKey: "sk-ant-..."   # operator BYO key / managed key (REQUIRED)
  # serviceKey: ""                # AUTO_WORKER_SERVICE_KEY — GENERATED when empty
  # namespace: ""                 # defaults to the release namespace
  # internalUrl: ""               # defaults to http://<release>-web
```

`auto.serviceKey` (the `AUTO_WORKER_SERVICE_KEY` shared between the web app, the
sweep, and the worker) is **generated** and preserved across upgrades when left
empty, so the only Auto value you must supply is the `ANTHROPIC_API_KEY`.

Enabling Auto renders, in addition to the web app:

- a dedicated **ServiceAccount** for the web pod;
- a namespaced **Role + RoleBinding** granting it `create/get/list/watch/delete`
  on `batch/v1` Jobs and read on pods/logs (so the dispatcher can create Jobs);
- the **Auto env** on the web Deployment (`AUTO_DISPATCH=k8s`, `AUTO_K8S_*`,
  `WEB_FORGE_INTERNAL_URL`, the service key + Anthropic key from the secret);
- the per-minute **sweep CronJob**.

When using a plain external Secret (`web.secrets.existingSecret`), add the Auto
keys to it: **`ANTHROPIC_API_KEY`** and **`AUTO_WORKER_SERVICE_KEY`**.

Apply with your normal flow, e.g. layered on the k3s self-host preset:

```sh
helm upgrade --install agentkitforge-web charts/agentkitforge-web \
  --namespace agentkitforge-web --create-namespace \
  --values charts/agentkitforge-web/values-k3s.yaml \
  --set web.config.appUrl=https://forge.example.com \
  --set web.auth.oidc.issuer=https://idp.example.com/realms/main \
  --set web.auth.oidc.clientId=agentkitforge-web \
  --set web.secrets.oidcClientSecret=<client-secret> \
  --set auto.enabled=true \
  --set auto.workerImage=ghcr.io/agentkitproject/agentkitauto-worker:<tag> \
  --set auto.anthropicApiKey=sk-ant-...
```

## 3. Database schema

The four Auto tables (`auto_runs`, `auto_approvals`, `auto_schedules`,
`auto_webhooks`) are created **idempotently** (`CREATE TABLE IF NOT EXISTS`) by
`ensureAutoSchema()` on first use — both the web app's selfhost Auto storage and
the worker run it on boot. No manual migration is required for the bundled
Postgres. If you point at an **external** Postgres with restricted DDL, apply
`agentkitauto-core/src/adapters/selfhost/schema.sql` once yourself.

## What works / what's deferred

- **Works**: on-demand runs, scheduled (cron) runs via the sweep CronJob, inbound
  webhook triggers, staged input files, and **webhook** result delivery (provider
  agnostic, behind the SSRF guard).
- **Deferred**: **email result delivery on self-host**. The self-host
  `EmailSender` is a **no-op** (logs a warning, returns `skipped`) — SMTP wiring
  is not yet implemented. Webhook delivery is unaffected. A run is never failed by
  a skipped email.

## Verifying

1. Create a standing approval + start an on-demand run from the Forge UI (or the
   Auto API). The run should appear `queued`, and a `auto-run-…` Job should be
   created in the Auto namespace:
   ```sh
   kubectl -n forge get jobs -l app.kubernetes.io/component=auto-worker
   kubectl -n forge logs job/<auto-run-…>
   ```
2. Create a schedule; within a minute the sweep CronJob should fire and dispatch
   a run:
   ```sh
   kubectl -n forge get cronjob forge-auto-sweep
   kubectl -n forge get jobs -l app.kubernetes.io/component=auto-sweep
   ```
