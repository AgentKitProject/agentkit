# agentkitforge Helm chart

Self-hosts the **AgentKitForge WebApp** (Next.js 15 standalone server running
`@agentkitforge/core` server-side) with `KITSTORE_BACKEND=selfhost`:

- **`web`** Deployment + Service — the Next.js standalone server (`node server.js`),
  port 3000, `/health` readiness + liveness probes.
- **Bundled Postgres** (metadata + per-user settings) — persistent PVC.
- **Bundled MinIO** (kit trees, S3-compatible) — persistent PVC; the app
  auto-creates the bucket on startup.
- Optional ingress (Traefik on k3s, or any IngressClass / Tailscale).

For a turnkey self-host walkthrough see
[`docs/SELF_HOSTING.md`](../../docs/SELF_HOSTING.md). The
[`values-k3s.yaml`](./values-k3s.yaml) preset configures generic OIDC auth,
plain k8s Secrets, BYO LLM key, and Market OFF.

## Quick install (k3s)

```sh
helm install agentkitforge ./charts/agentkitforge -f ./charts/agentkitforge/values-k3s.yaml \
  --set web.config.appUrl=https://forge.example.com \
  --set web.auth.oidc.issuer=https://idp.example.com/realms/main \
  --set web.auth.oidc.clientId=agentkitforge \
  --set web.secrets.oidcClientSecret="<client secret from your IdP>"
```

## Auth model

The web Forge is **logged-in by design** — every `/api/*` route requires an
authenticated user. Two pluggable providers (`web.auth.provider`):

- **`oidc`** (self-host): generic OpenID Connect (Auth Code + PKCE), sealed with
  iron-session. Set `web.auth.oidc.{issuer,clientId}` +
  `web.secrets.oidcClientSecret`. This also marks the instance self-hosted
  (Market off by default, BYO LLM only, ecosystem links hidden unless set).
- **`workos`** (default; hosted SaaS): WorkOS AuthKit cookie sessions.

## Generated secrets

The chart-managed Secret holds every genuinely-secret value. Anything you don't
supply that the chart *can* generate is **generated and preserved across
`helm upgrade`** (via `lookup` of the live Secret) — so nothing is ever
`changeme`:

- `SESSION_SECRET` (OIDC) / `WORKOS_COOKIE_PASSWORD` (you supply for WorkOS)
- `AGENTKITFORGE_WEB_SECRET` (AES-256-GCM at-rest key for per-user LLM keys)
- `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`

You always supply the genuinely-external secrets: the OIDC client secret (or
WorkOS API key/client id).

## Auto-defaulted in-cluster URLs

So the secret only carries genuinely-secret values:

- `DATABASE_URL` is composed from `postgres.user/database` + the secret's
  `POSTGRES_PASSWORD`, pointing at the bundled Postgres Service.
- `S3_ENDPOINT` defaults to the bundled MinIO Service; `S3_BUCKET` defaults to
  `minio.bucket`; `S3_ACCESS_KEY_ID` defaults to `minio.rootUser`;
  `S3_SECRET_ACCESS_KEY` reads the secret's `MINIO_ROOT_PASSWORD`.

To use an **external** Postgres/MinIO, set `postgres.enabled=false` /
`minio.enabled=false` and provide `DATABASE_URL` / `S3_ENDPOINT` (+ `S3_*`) in
the secret.

## Bring your own Secret (GitOps)

Set `web.secrets.existingSecret` to a plain Secret you manage. The chart then
renders **no** Secret of its own; the web container `envFrom`s it, and the
bundled Postgres/MinIO read their passwords from it. Required keys:

- **oidc**: `OIDC_CLIENT_SECRET`, `SESSION_SECRET`, `AGENTKITFORGE_WEB_SECRET`,
  `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`
- **workos**: `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`,
  `AGENTKITFORGE_WEB_SECRET`, `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`

A clean ArgoCD Application example is at
[`deploy/argocd-example/agentkitforge-app.yaml`](../../deploy/argocd-example/agentkitforge-app.yaml).

## AgentKitAuto

AgentKitAuto is a **separate self-host app** with its own Helm chart in the
`agentkitauto-app` repo (`charts/agentkitauto`) — it runs the Auto control
plane, worker RBAC, and schedule sweep there, not in this chart. Forge only
**links out** to it: set `web.config.ecosystemLinks.autoUrl` to the Auto app's
public origin (`NEXT_PUBLIC_AUTO_URL`).
