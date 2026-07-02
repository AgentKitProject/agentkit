# Self-hosting AgentKitForge WebApp on k3s

Run a fully standalone AgentKitForge WebApp on your own Kubernetes cluster
(k3s, k0s, or any vanilla k8s). A self-host instance does **not** phone home to
the hosted AgentKitProject ecosystem: no hosted Market, no managed LLM gateway,
no Stripe credits, no `*.agentkitproject.com` links.

What you get:

- **Auth**: generic **OpenID Connect** (Authorization Code + PKCE), so you bring
  your own IdP — Keycloak, Authentik, Auth0, Okta, Dex, etc.
  (`AUTH_PROVIDER=oidc`).
- **Data**: `KITSTORE_BACKEND=selfhost` — kit trees in **MinIO**, metadata +
  per-user settings in **Postgres**. Both are **bundled** in the chart (persistent
  PVCs on the local-path StorageClass that ships with k3s).
- **LLM**: **bring your own key** only. Users configure a provider (Anthropic,
  OpenAI, Gemini, Ollama, …) in Settings; there is no managed/metered inference.
- **Secrets**: **plain Kubernetes Secrets**. The chart generates everything it
  can (session secret, the at-rest encryption key, the Postgres + MinIO
  passwords) and preserves them across `helm upgrade` — you only supply your
  OIDC client secret.

## Prerequisites

- A k3s (or other) cluster with a default StorageClass (`local-path` on k3s).
- `helm` 3.8+ and `kubectl`.
- An OIDC provider with a client registered for this app. Set the client's
  redirect URI to **`{APP_URL}/auth/callback`** (e.g.
  `https://forge.example.com/auth/callback`).

## One-command install

```sh
helm install agentkitforge ./charts/agentkitforge -f ./charts/agentkitforge/values-k3s.yaml \
  --set web.config.appUrl=https://forge.example.com \
  --set web.auth.oidc.issuer=https://idp.example.com/realms/main \
  --set web.auth.oidc.clientId=agentkitforge \
  --set web.secrets.oidcClientSecret="<client secret from your IdP>"
```

That renders the web Deployment + Service, bundled Postgres + MinIO (with PVCs),
and a chart-managed Secret holding your OIDC client secret plus generated
`SESSION_SECRET`, `AGENTKITFORGE_WEB_SECRET`, and the DB/MinIO passwords. The app
auto-creates the MinIO bucket on startup.

Expose it with the bundled Traefik ingress (k3s):

```sh
helm upgrade agentkitforge ./charts/agentkitforge -f ./charts/agentkitforge/values-k3s.yaml \
  --reuse-values \
  --set web.ingress.enabled=true \
  --set web.ingress.className=traefik \
  --set web.ingress.host=forge.example.com
```

…or front it with your own ingress / LoadBalancer / Tailscale and skip
`web.ingress`.

## Bring your own Secret (recommended for GitOps)

Instead of inline `--set`, create a plain Secret and reference it. The chart
then manages **no** Secret of its own:

```sh
kubectl create namespace agentkitforge
kubectl -n agentkitforge create secret generic agentkitforge-secret \
  --from-literal=OIDC_CLIENT_SECRET="<client secret>" \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 32)" \
  --from-literal=AGENTKITFORGE_WEB_SECRET="$(openssl rand -base64 32)" \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=MINIO_ROOT_PASSWORD="$(openssl rand -base64 24)"

helm install agentkitforge ./charts/agentkitforge -f ./charts/agentkitforge/values-k3s.yaml \
  --namespace agentkitforge \
  --set web.config.appUrl=https://forge.example.com \
  --set web.auth.oidc.issuer=https://idp.example.com/realms/main \
  --set web.auth.oidc.clientId=agentkitforge \
  --set web.secrets.existingSecret=agentkitforge-secret
```

### ArgoCD

A clean example Application (no placeholders, no Infisical) is at
[`deploy/argocd-example/agentkitforge-app.yaml`](../deploy/argocd-example/agentkitforge-app.yaml).
It points at the chart in this repo with `valueFiles: [values-k3s.yaml]` and
references a plain Secret you supply.

## Key configuration

| Setting | Env | Default |
|---|---|---|
| `web.auth.provider` | `AUTH_PROVIDER` | `workos` (set `oidc` for self-host) |
| `web.auth.oidc.issuer` | `OIDC_ISSUER` | — (required) |
| `web.auth.oidc.clientId` | `OIDC_CLIENT_ID` | — (required) |
| `web.secrets.oidcClientSecret` | `OIDC_CLIENT_SECRET` | — (required) |
| `web.auth.oidc.scopes` | `OIDC_SCOPES` | `openid profile email` |
| `web.config.appUrl` | `APP_URL` | — (required); `OIDC_REDIRECT_URI` derives `{appUrl}/auth/callback` |
| `web.secrets.sessionSecret` | `SESSION_SECRET` | generated |
| `web.secrets.forgeWebSecret` | `AGENTKITFORGE_WEB_SECRET` | generated (at-rest key for BYO LLM keys) |
| `web.config.marketBaseUrl` | `AGENTKITMARKET_BASE_URL` | empty → **Market OFF** (set to your own Market to enable) |
| `web.config.disableMarket` | `DISABLE_MARKET` | `false` |
| `web.config.kitstoreBackend` | `KITSTORE_BACKEND` | `selfhost` |
| `web.config.ecosystemLinks.*` | `NEXT_PUBLIC_{PROJECT,FORGE,PROFILE,AUTO}_URL` | unset → link hidden |

Setting `AUTH_PROVIDER=oidc` automatically flips the instance to self-host mode
(`SELF_HOST=true`, Market off-by-default, ecosystem links hidden). To run an
OIDC-less self-host, leave `provider: workos` and set `web.auth.selfHost: true`.

See [`.env.example`](../.env.example) for the full env contract.

## Container image

The chart pulls `ghcr.io/agentkitproject/agentkitforge` — a **public**,
**multi-arch** (`linux/amd64` + `linux/arm64`) image built by
`.github/workflows/image.yml`. The chart tracks `latest` by default; pin
`web.image.tag` to a release tag for reproducible deploys.

## Optional: AgentKitAuto

Autonomous Agent Kit runs are **opt-in** and **off by default**. To enable, set
`auto.enabled=true` and supply a worker image + an `ANTHROPIC_API_KEY` (your BYO
key). See [`SELF_HOST_AUTO.md`](./SELF_HOST_AUTO.md) for the full guide.
