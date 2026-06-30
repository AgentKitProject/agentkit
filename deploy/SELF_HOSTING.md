# Self-Hosting the AgentKitProject Ecosystem on Kubernetes

Run the **full open-core stack** — **Market**, **Web Forge**, and **AgentKitAuto** —
on **your own** Kubernetes cluster, with **your own** OIDC identity provider, plain
Kubernetes Secrets, and **no** dependency on AWS, WorkOS, Stripe, or any
`*.agentkitproject.com` service. The same web and worker images that run the hosted
ecosystem run here; cloud coupling sits behind swappable adapters
(`KITSTORE_BACKEND=selfhost` → Postgres + MinIO instead of DynamoDB + S3).

This is the **full-stack entry point**. Each app also has a focused per-chart doc:

- Market only: [`packages/market-core/docs/SELF_HOSTING.md`](../packages/market-core/docs/SELF_HOSTING.md)
- Web Forge: [`apps/forge-web/docs/SELF_HOSTING.md`](../apps/forge-web/docs/SELF_HOSTING.md)
- Auto: [`apps/forge-web/docs/SELF_HOST_AUTO.md`](../apps/forge-web/docs/SELF_HOST_AUTO.md)

> **You rarely need to self-host anything.** The desktop **AgentKitForge** app and
> all local kit work (create / validate / package / import / export) run entirely on
> a workstation with no account and no server. Self-hosting applies only to the
> optional cloud services below.

---

## 1. Topology

Each app is its **own Helm chart / release**, integrated **in-cluster**. A typical
full-stack install runs all three in one namespace:

```
                         your OIDC IdP  (Keycloak / Authentik / Dex / Auth0 / Okta / Entra ID …)
                                ▲   ▲   ▲
                 sign-in / admin │   │   │  (one client registered per app)
        ┌───────────────────────┘   │   └───────────────────────┐
        │                           │                           │
  ┌─────┴───────────┐      ┌────────┴─────────┐      ┌───────────┴────────┐
  │ agentkitmarket  │      │ agentkitforge-web│      │ agentkitauto       │
  │  web + api +    │      │  Next.js web     │      │  web + k8s Job-per- │
  │  worker         │      │                  │      │  run worker + sweep │
  └───┬─────────┬───┘      └───┬──────────┬───┘      └───┬──────────┬──────┘
      │         │              │          │              │          │
   Postgres  MinIO  Redis   Postgres   MinIO          Postgres   MinIO
   (catalog) (pkgs) (queue) (metadata) (kit trees)    (runs)     (inputs)
      ▲                                                              ▲
      └──────────────── in-cluster Service ─────────────────────────┘
        Forge-web + Auto reach Market at
        http://agentkitmarket-web.<ns>.svc.cluster.local:80
```

Key facts:

- **Three separate charts**, deployed independently. Forge-web and Auto **link to**
  and **call** Market over the in-cluster Service — they do not embed it.
- Each app brings its **own** bundled Postgres + MinIO (single-replica, fine for a
  self-host node; point at external instances for HA). Market additionally brings a
  bundled Redis for its validation queue.
- **Public Market catalog browsing needs no login.** OIDC only gates sign-in, admin
  review, submit, and browser-initiated downloads. Forge-web and Auto require sign-in
  for their authenticated surfaces.
- **Auto is BYO-LLM.** Each Auto run executes in a one-shot Kubernetes Job using the
  operator's own `ANTHROPIC_API_KEY` — no managed credits, gateway, or metering.

---

## 2. Prerequisites

- A Kubernetes cluster (k3s, k0s, or any vanilla k8s) with a **default StorageClass**
  (`local-path` on k3s). The presets in this guide target k3s.
- `helm` 3.8+ and `kubectl`, pointed at the cluster.
- An **OIDC identity provider** you control, reachable from inside the cluster over
  valid TLS. See §4. **Register the OIDC client(s) in your IdP _before_ `helm install`**
  — each app performs OIDC discovery on startup, so a web pod **crash-loops** until its
  client (and the issuer's `/.well-known/openid-configuration`) is reachable.
- DNS / ingress for the public hostnames you'll give each app (e.g.
  `market.example.com`, `forge.example.com`, `auto.example.com`). k3s ships a Traefik
  IngressClass; the presets default `className: traefik`.
- **Pull access to Docker Hub** for the bundled data services. The "no pull secret"
  note in §3 covers only the GHCR **app** images; the bundled data services pull
  `postgres:16.14`, a pinned `minio/minio:RELEASE.*` tag, and `redis:7.4.9-alpine` from **Docker Hub**. An
  air-gapped or Docker-Hub-rate-limited cluster must mirror those images (and point the
  charts' `postgres.image` / `minio.image` / `redis.image` values at the mirror).

---

## 3. Images & versioned releases

Pin every image to a **versioned self-host release tag**, not `:latest` or a raw
commit sha. A versioned release retags the already-built, already-tested multi-arch
(`linux/amd64` + `linux/arm64`) images to a `vX.Y.Z` tag.

| Chart | Image | Pin to |
|---|---|---|
| `agentkitmarket` (api/worker) | `ghcr.io/agentkitproject/agentkitmarket-core` | `v0.6.0` |
| `agentkitmarket` (web) | `ghcr.io/agentkitproject/agentkitmarket-app` | `v0.6.0` |
| `agentkitforge-web` (web) | `ghcr.io/agentkitproject/agentkitforge-web` | `v0.6.0` |
| `agentkitauto` (web) | `ghcr.io/agentkitproject/agentkitauto-app` | `v0.6.0` |
| `agentkitauto` (worker) | `ghcr.io/agentkitproject/agentkitauto-worker` | `v0.6.0` |

All images are **public** on GHCR — no pull secret is required.

**How releases are produced (so you can trust the tag):** the per-commit CI
workflows (`image-*.yml`) build and push `sha-<sha>` and `latest` on every push to
`main` (and on manual dispatch). A versioned release is cut by the **manual**
`release-selfhost` workflow (Actions → *release-selfhost* → Run workflow →
`version=v0.6.0`), which promotes one of those already-built builds to the `vX.Y.Z`
tag with `docker buildx imagetools` (a retag — no rebuild). So `vX.Y.Z` is the exact
multi-arch image CI already tested. Pin to it.

The chart **default** tags are still `:latest` (which tracks `main`); every install
example below overrides them to `v0.6.0`.

The five **app** images above are the only ones the versioned release pins. The
bundled **data-service** images (`postgres:16.14`, a pinned `minio/minio:RELEASE.*`, `redis:7.4.9-alpine` — pinned in the chart defaults) are
pulled from Docker Hub and are **not** part of the versioned self-host release — pin
them yourself via the charts' `postgres.image` / `minio.image` / `redis.image` values
if you need fully reproducible data-tier images.

---

## 4. OIDC IdP setup

All three apps authenticate against **one** generic OpenID Connect IdP using the
authorization-code flow. Register **one client per app** (recommended — distinct
redirect URIs and secrets), or share a single client across apps if your IdP allows
multiple redirect URIs on one client.

For each app:

| App | Suggested client id | Redirect URI |
|---|---|---|
| Market | `agentkitmarket` | `https://market.example.com/auth/callback` |
| Web Forge | `agentkitforge-web` | `https://forge.example.com/auth/callback` |
| Auto | `agentkitauto` | `https://auto.example.com/auth/callback` |

The redirect URI is always **`<appUrl>/auth/callback`** (derived automatically from
`web.config.appUrl`; override with the per-chart `redirectUri` value if needed).

- **Scopes:** `openid profile email` (the default). Override with `OIDC_SCOPES` via
  the chart if your IdP needs more.
- **Groups/roles claim:** if you want group-based admin (Market), have the IdP emit a
  `groups` or `roles` claim in the ID token.
- **Issuer:** must serve `<issuer>/.well-known/openid-configuration`. Use the **HTTPS**
  issuer URL. (`OIDC_ALLOW_INSECURE=true` exists for an `http://` dev IdP only — never
  in production.)

### Users & admins

**You don't create users in the app — they live in your IdP.** None of the three
apps have a signup flow or a user database. The first time someone signs in through
OIDC, a session is provisioned straight from their token claims (`sub` → user id,
`email`, and a display name from `name` / `given_name`+`family_name` /
`preferred_username`). To **onboard** a user, create or invite them in your IdP and
grant them access to the app's OIDC client — that's it; they sign in and they're in.
To **offboard**, remove or disable them in your IdP. (Pair this with
`REQUIRE_LOGIN=true` — section 10 — if the instance is internet-facing and should be
private, so only signed-in IdP users can reach it.)

**Admins** are granted by an OIDC group claim (`ADMIN_OIDC_GROUP`) or the
`ADMIN_EMAILS` allowlist — see *Granting Market admin* just below.

**Display names / publisher attribution come from the IdP — you do NOT need to run
AgentKitProfile.** When a user submits a kit, the publisher name is taken from their
OIDC display name (falling back to the email local-part if the IdP emits no name). The
public-profile service (the `/u/<handle>` pages) is **not** part of open-core self-host
and is **not** required for submissions or any core flow — leaving `PROFILE_API_BASE_URL`
unset is the supported path. A single user or a small team needs nothing extra.

### Granting Market admin

A signed-in Market user becomes an **admin** when **either**:

- the configured admin group (`web.config.oidc.adminGroup` → `ADMIN_OIDC_GROUP`)
  appears in their token's `groups`/`roles` claim, **or**
- their email is in `web.config.adminEmails` (emitted as both `ADMIN_EMAILS` and
  `AGENTKITMARKET_ADMIN_EMAILS`).

Use whichever fits your IdP, or both. If neither is set, no one is an admin (everyone
can still browse and submit as a regular user).

### Client-secret coordination (read this)

Each app reads its **`OIDC_CLIENT_SECRET`** from its own Kubernetes Secret. That value
must **byte-match** the client secret configured for that app's client in the IdP.

- One client per app → one secret per app. Give each chart its matching secret.
- The app loads the secret into its environment **at pod start**. **Changing a client
  secret requires restarting the app pod** (`kubectl rollout restart deploy/<app>-web`)
  — and restarting the IdP too if your IdP reads client secrets from its own env.

### In-cluster IdP edge case (usually N/A)

If your IdP runs **inside** the same cluster (e.g. a bundled Dex), the app pods must be
able to resolve **and** reach the issuer URL over **valid TLS** — the issuer string the
app discovers must be the same hostname the browser uses, and the in-cluster cert must
be trusted. The self-host canary handled this with a CoreDNS rewrite plus copying the
issuer's cert into the app's trust store. A normal company IdP is externally reachable
over public TLS, so this does **not** apply to most installs.

---

## 5. Secrets model (per chart)

All charts use **plain Kubernetes Secrets**. With the k3s presets (`secrets.generate`
on / chart-managed web secret), anything the chart can generate — `SESSION_SECRET`,
the at-rest encryption key, Postgres / MinIO passwords, Market's `ADMIN_API_KEY`,
Auto's worker service key — is generated on first install and **persisted across
`helm upgrade`** (read back via `lookup`). The **only** secret you always supply is
each app's `OIDC_CLIENT_SECRET` (plus, for Auto, your `ANTHROPIC_API_KEY`).

### Bring-your-own (BYO) Secret — for GitOps

To keep secrets out of the chart entirely, create a plain Kubernetes Secret yourself
(Sealed Secrets, External Secrets, SOPS, …) and reference it via the chart's
`existingSecret` value. **When you do this, the chart generates nothing for that
secret — your Secret must contain every key the chart would otherwise have
generated.** The exact key set differs per chart, and there is one important gotcha.

> **⚠️ The bundled-Postgres / MinIO gotcha (forge-web & auto).**
> On the **forge-web** and **auto** charts, the bundled Postgres and MinIO read their
> passwords (`POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`) **from the same web
> `existingSecret`** (the "effective web secret"). So a BYO web secret for those two
> charts **must include those keys**, or the bundled Postgres starts with an empty
> password and crash-loops. Auto additionally needs `AUTO_WORKER_SERVICE_KEY` (and
> your `ANTHROPIC_API_KEY`) in that same secret.
>
> The **market** chart is different: it generates its Postgres / MinIO passwords in a
> *separate* backend secret, independent of the web secret — so the market **web**
> existingSecret does **not** include pg/minio keys (those go in the market
> **backend** existingSecret instead).

#### Market — BYO secret keys

Market has **two** secret surfaces: the **web** secret and the **backend** (api/worker)
secret.

`web.secrets.existingSecret` (web tier) must contain:

| Key | Notes |
|---|---|
| `AGENTKITMARKET_ADMIN_KEY` | Must match the backend `ADMIN_API_KEY`. |
| `OIDC_CLIENT_SECRET` | From your IdP (OIDC mode). |
| `SESSION_SECRET` | iron-session cookie secret, ≥ 32 chars. |
| `PROFILE_SERVICE_KEY` | *Optional* — only if you run a Profile API. |

`secrets.existingSecret` (backend tier) must contain:

| Key | Notes |
|---|---|
| `ADMIN_API_KEY` | Must match the web `AGENTKITMARKET_ADMIN_KEY`. |
| `DATABASE_URL` | e.g. `postgresql://agentkitmarket:pass@agentkitmarket-postgres:5432/agentkitmarket` |
| `S3_ENDPOINT` | e.g. `http://agentkitmarket-minio:9000` |
| `PACKAGE_BUCKET_NAME` | e.g. `agentkit-packages` |
| `S3_ACCESS_KEY_ID` | Must equal `minio.rootUser` for bundled MinIO. |
| `S3_SECRET_ACCESS_KEY` | Must equal `MINIO_ROOT_PASSWORD` for bundled MinIO. |
| `REDIS_URL` | e.g. `redis://agentkitmarket-redis:6379` |
| `POSTGRES_PASSWORD` | Bundled Postgres reads this. |
| `MINIO_ROOT_PASSWORD` | Bundled MinIO reads this. |

> **Two distinct Market BYO paths — don't conflate them.** Market is the only chart
> with **two** `existingSecret` values: the **backend** path is the **top-level**
> `secrets.existingSecret` (the 10 backend keys above, consumed by the api/worker
> pods), while the **web** path is `web.secrets.existingSecret` (the web keys above,
> consumed by the web pod). They are separate Secrets referenced by separate values.
> To go fully BYO on Market, create **both** and set **both**, e.g.:
>
> ```bash
> helm install agentkitmarket ./deploy/charts/agentkitmarket \
>   -f deploy/charts/agentkitmarket/values-k3s.yaml -f market-values.yaml \
>   --set secrets.existingSecret=agentkitmarket-backend-secret \
>   --set web.secrets.existingSecret=agentkitmarket-web-secret \
>   --namespace agentkit
> ```
>
> (forge-web and auto have only **one** `existingSecret` — the web one — which is why
> their pg/minio passwords must live in it; see the gotcha above.)

#### Web Forge — BYO secret keys (`web.secrets.existingSecret`)

| Key | Notes |
|---|---|
| `OIDC_CLIENT_SECRET` | From your IdP. |
| `SESSION_SECRET` | ≥ 32 chars. |
| `AGENTKITFORGE_WEB_SECRET` | AES-256-GCM key for at-rest BYO-LLM-key encryption. |
| `POSTGRES_PASSWORD` | **Required** — bundled Postgres reads it from this secret. |
| `MINIO_ROOT_PASSWORD` | **Required** — bundled MinIO reads it from this secret. |

#### Auto — BYO secret keys (`web.secrets.existingSecret`)

| Key | Notes |
|---|---|
| `OIDC_CLIENT_SECRET` | From your IdP. |
| `SESSION_SECRET` | ≥ 32 chars. |
| `AGENTKITFORGE_WEB_SECRET` | At-rest encryption key. |
| `POSTGRES_PASSWORD` | **Required** — bundled Postgres reads it from this secret. |
| `MINIO_ROOT_PASSWORD` | **Required** — bundled MinIO reads it from this secret. |
| `AUTO_WORKER_SERVICE_KEY` | **Required** — shared by the web app, the sweep, and the worker Jobs. |
| `ANTHROPIC_API_KEY` | **Required** — the operator's BYO LLM key. |

> `GATEWAY_SERVICE_KEY` is referenced by the Auto web Deployment **optionally** and is
> **not generated** by the chart — it is part of the commercial managed-billing path,
> which is **not** open-core. On a self-host it is correctly **absent**. Do **not** add
> it to your secret.

To generate the values for a BYO secret yourself, for example:

```bash
SESSION_SECRET=$(openssl rand -base64 32)
AGENTKITFORGE_WEB_SECRET=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -base64 24)
MINIO_ROOT_PASSWORD=$(openssl rand -base64 24)
AUTO_WORKER_SERVICE_KEY=$(openssl rand -hex 32)
```

---

## 6. Install

Deploy all three into one namespace (e.g. `agentkit`). The Market **release name must
be `agentkitmarket`** so its in-cluster web Service is named `agentkitmarket-web` —
that's the name Forge-web and Auto wire to in §7. The bundled data-service Services are
named after each release (`<release>-postgres`, `<release>-minio`, `<release>-redis`),
which the charts auto-default internally.

Keep secrets off the CLI by putting them in per-app values files (not committed). Each
example uses the chart's `values-k3s.yaml` preset (OIDC on, bundled data services,
plain Secrets, chart-generated credentials) plus a small override file.

### 6a. Market

```yaml
# market-values.yaml  (keep out of git)
image:
  tag: "v0.6.0"
web:
  image:
    tag: "v0.6.0"
  config:
    appUrl: https://market.example.com
    adminEmails: "you@example.com"      # optional admin allowlist
    oidc:
      issuer: https://idp.example.com
      clientId: agentkitmarket
      adminGroup: agentkit-admins       # optional group-based admin
  secrets:
    oidcClientSecret: "<market client secret from your IdP>"
  ingress:
    host: market.example.com
```

```bash
helm install agentkitmarket ./deploy/charts/agentkitmarket \
  -f deploy/charts/agentkitmarket/values-k3s.yaml \
  -f market-values.yaml \
  --namespace agentkit --create-namespace
```

The chart generates and persists `ADMIN_API_KEY`, `SESSION_SECRET`, the Postgres
password, and the MinIO root password, and wires the backend admin key into the web
tier automatically. The api runs `schema.sql` on startup under a Postgres advisory
lock and auto-creates the MinIO bucket.

### 6b. Web Forge

```yaml
# forge-values.yaml  (keep out of git)
web:
  image:
    tag: "v0.6.0"
  config:
    appUrl: https://forge.example.com
    # Wire to the in-cluster Market (see §7). Leave empty for Market OFF.
    marketBaseUrl: http://agentkitmarket-web.agentkit.svc.cluster.local:80
  auth:
    oidc:
      issuer: https://idp.example.com
      clientId: agentkitforge-web
  secrets:
    oidcClientSecret: "<forge client secret from your IdP>"
  ingress:
    enabled: true
    className: traefik
    host: forge.example.com
```

```bash
helm install agentkitforge-web ./deploy/charts/agentkitforge-web \
  -f deploy/charts/agentkitforge-web/values-k3s.yaml \
  -f forge-values.yaml \
  --namespace agentkit
```

`AUTH_PROVIDER=oidc` (set by the preset) automatically flips the instance to self-host
mode: `SELF_HOST=true`, Market off-by-default, ecosystem links hidden unless set.
`SESSION_SECRET`, `AGENTKITFORGE_WEB_SECRET`, and the Postgres + MinIO passwords are
generated and persisted. The app auto-creates its MinIO bucket on startup.

### 6c. Auto

```yaml
# auto-values.yaml  (keep out of git)
web:
  image:
    tag: "v0.6.0"
  config:
    appUrl: https://auto.example.com
    # Wire to the in-cluster Market (see §7). Leave empty for Market OFF.
    marketBaseUrl: http://agentkitmarket-web.agentkit.svc.cluster.local:80
  auth:
    oidc:
      issuer: https://idp.example.com
      clientId: agentkitauto
  secrets:
    oidcClientSecret: "<auto client secret from your IdP>"
  ingress:
    enabled: true
    className: traefik
    host: auto.example.com
auto:
  enabled: true
  workerImage: "ghcr.io/agentkitproject/agentkitauto-worker:v0.6.0"
  billing: "free"                       # BYO key, no metering
  anthropicApiKey: "sk-ant-..."         # REQUIRED — operator BYO LLM key
```

```bash
helm install agentkitauto ./deploy/charts/agentkitauto \
  -f deploy/charts/agentkitauto/values-k3s.yaml \
  -f auto-values.yaml \
  --namespace agentkit
```

Enabling Auto renders, in addition to the web app: a dedicated ServiceAccount for the
web pod; a namespaced Role + RoleBinding letting the dispatcher create worker Jobs; the
Auto env on the web Deployment (`AUTO_DISPATCH=k8s`, …); and the per-minute schedule
**sweep CronJob** (`agentkitauto-auto-sweep`). `AUTO_WORKER_SERVICE_KEY` is generated
and persisted; the only Auto value you must supply is `anthropicApiKey`. The four Auto
tables are created idempotently on first use — no manual migration for the bundled
Postgres.

> **`anthropicApiKey` is not enforced at install time.** The chart does **not** guard
> against an empty `auto.anthropicApiKey` — Auto installs and the web app comes up
> **healthy** without it. The miss only surfaces at **run time**: a worker Job starts
> with no LLM key and the run fails. Set a real key before you depend on runs (and
> after rotating it, restart the web pod so it reloads — see §9).

> **BYO secret for forge-web / auto:** if you set `web.secrets.existingSecret` instead
> of inline secrets on these charts, your Secret **must** include `POSTGRES_PASSWORD`
> and `MINIO_ROOT_PASSWORD` (and, for Auto, `AUTO_WORKER_SERVICE_KEY` +
> `ANTHROPIC_API_KEY`) — see §5.

---

## 7. Wiring the apps together

Forge-web and Auto reach Market **in-cluster** via Market's web Service. With the
Market release named `agentkitmarket` in namespace `agentkit`, that Service is:

```
http://agentkitmarket-web.agentkit.svc.cluster.local:80
```

Set this as `web.config.marketBaseUrl` (→ `AGENTKITMARKET_BASE_URL`) on **both**
forge-web and auto (done in the values files above) to enable kit import / favorites /
licensed flows against your own Market. Leaving `marketBaseUrl` **empty** keeps Market
**OFF** (no phone-home; the only correct default if you are not running Market).

For cross-app navigation links in the UI, set the ecosystem-link overrides on
forge-web and auto (unset links are hidden on self-host):

```yaml
web:
  config:
    ecosystemLinks:
      forgeUrl: https://forge.example.com
      autoUrl: https://auto.example.com
      # projectUrl / profileUrl as applicable
```

(Market exposes the analogous `web.config.forgeUrl` for its "open in Forge" link.)

---

## 8. Verify

```bash
# All pods Ready across the three releases:
kubectl -n agentkit get pods

# Market backend came up and ran the schema:
kubectl -n agentkit logs deploy/agentkitmarket-api
#   → "agentkitmarket-core server listening on :8080"

# Market backend health (no ingress needed). The api container listens on 8080;
# its Service exposes that as port 80, so "8080:80" maps localhost:8080 → Service:80
# (the two 8080s mean different things: local-forward port vs container port).
kubectl -n agentkit port-forward svc/agentkitmarket-api 8080:80 &
curl http://localhost:8080/health

# Web health endpoints. NOTE the Service names: each web Service is "<release>-web",
# so forge-web's is "agentkitforge-web-web" (release "agentkitforge-web" + the "-web"
# suffix) and auto's is "agentkitauto-web". (Market's is "agentkitmarket-web".)
kubectl -n agentkit port-forward svc/agentkitforge-web-web 8081:80 &
curl http://localhost:8081/health
kubectl -n agentkit port-forward svc/agentkitauto-web 8082:80 &
curl http://localhost:8082/health
```

Then open each app in a browser and **sign in via your IdP**:

- `https://market.example.com` — public catalog loads without login; sign-in,
  submit, and admin review go through your IdP. Confirm your admin account sees the
  review queue.
- `https://forge.example.com` — sign in, create/validate/package a kit; if
  `marketBaseUrl` is set, import from your Market.
- `https://auto.example.com` — sign in, start an on-demand run. A worker Job appears:

```bash
kubectl -n agentkit get jobs -l app.kubernetes.io/component=auto-worker
# Create a schedule, then within a minute the sweep fires:
kubectl -n agentkit get cronjob agentkitauto-auto-sweep
```

---

## 9. Upgrading

Bump the pinned image tags and re-run `helm upgrade` per chart:

```bash
helm upgrade agentkitmarket ./deploy/charts/agentkitmarket \
  -f deploy/charts/agentkitmarket/values-k3s.yaml -f market-values.yaml \
  --namespace agentkit

helm upgrade agentkitforge-web ./deploy/charts/agentkitforge-web \
  -f deploy/charts/agentkitforge-web/values-k3s.yaml -f forge-values.yaml \
  --namespace agentkit

helm upgrade agentkitauto ./deploy/charts/agentkitauto \
  -f deploy/charts/agentkitauto/values-k3s.yaml -f auto-values.yaml \
  --namespace agentkit
```

Generated credentials persist across upgrades (read back via `lookup`). Always pin to
a **versioned** image tag (§3) so upgrades are deliberate. If you rotate an
`OIDC_CLIENT_SECRET`, restart that app's pod so it reloads the new value (§4).

---

## 10. What is NOT in open-core self-host

A pure open-core self-host runs the **free / local** Market and Auto feature set. It
deliberately ships **none** of the commercial surfaces — no paid-kit checkout, no
seller payouts, and **no protected-kit ("run-on-Auto-only") capability**.

- A self-hosted Market **cannot serve protected paid kits.** Protection requires the
  commercial pieces (the entitlement table, the output watermark/redaction wiring, and
  the Market↔Auto service seam) that live outside open-core. None of the seller
  pricing/protection UI appears, and there is nothing to mark a kit "protected".
- Your self-host can still **run its own free / local kits on Auto** — the autonomous
  run path is open-core. Local and free runs never invoke the protected-kit
  prompt-resolution or leakage guards (the redactor defaults to identity).
- If a self-host has Market integration disabled (no resolvable Market base URL, or
  `DISABLE_MARKET=true`), any attempt to run a *Market* protected kit **fails closed**:
  there is no hosted fallback. This is correct and intentional.

In short: self-host gives you the full open-core product without the commercial moat.
Protected paid kits and managed Auto billing are hosted (or commercially-licensed)
capabilities.

---

## 11. Organization shared API keys (optional)

Team orgs can hold a single shared Anthropic API key that Auto (and Forge-web) fall
back to when a member has no BYO key of their own. The precedence is:

> managed billing (if enabled) → member's own BYO key → **org shared key** → operator key

This feature requires three apps to share the **same** `MARKET_SERVICE_KEY`:

| App | Where to set it |
|---|---|
| Market | `secrets.marketServiceKey` in your values file (or in `existingSecret`) |
| Forge-web | `secrets.marketServiceKey` in your values file (or in `existingSecret`) |
| Auto | `secrets.marketServiceKey` in your values file (or in `existingSecret`) |

When `MARKET_SERVICE_KEY` is identical across all three, Auto and Forge-web resolve
an org's shared key by calling the Market service endpoint with that key. Without
`MARKET_SERVICE_KEY` set (or when Market is disabled), org-key resolution **no-ops
silently** and members fall back to the operator key — the fail-open guarantee is
preserved. Local, offline, and `DISABLE_MARKET=true` installs are entirely unaffected.

### At-rest encryption (optional but recommended)

Market encrypts org API keys at rest using `MARKET_KEY_ENCRYPTION_SECRET`. The
agentkitmarket chart **auto-generates** a stable value on first install and persists it
across upgrades (the same mechanism as `SESSION_SECRET`), so encryption is active by
default — you do not need to set it manually.

To supply your own key (e.g. for key rotation or an external-secret workflow):

```bash
# Generate a strong 32-byte hex key:
MARKET_KEY_ENCRYPTION_SECRET=$(openssl rand -hex 32)
```

Then set it in your values:

```yaml
# market-values.yaml
secrets:
  marketKeyEncryptionSecret: "<value>"  # or use existingSecret
```

If using `existingSecret`, include `MARKET_KEY_ENCRYPTION_SECRET` in that secret.
Rotating the key requires re-encrypting existing org keys in the database before the
old pods stop serving.
