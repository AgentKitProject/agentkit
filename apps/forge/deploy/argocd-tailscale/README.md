# AgentKit self-host — Tailscale (ts.net) + real TLS, via ArgoCD

A GitOps bundle that stands up the **full AgentKit ecosystem** — Forge WebApp,
Market (catalog + review queue), and Auto — on **one isolated cluster**, exposed
on your **tailnet** at real `https://*.ts.net` names with **operator-minted
Let's Encrypt certs**. Login is OIDC against a **bundled Dex test IdP** (single
static user) that you later swap for your company IdP.

It is deployed as an **ArgoCD app-of-apps**: register one root Application and it
cascades to bootstrap → Dex → the three apps, in sync-wave order.

> This bundle assumes the tailnet suffix `tailf14b5e.ts.net` and the four hosts
> `dex` / `forge` / `market` / `auto`. **Replace the suffix with yours** before
> applying (see Prereqs → step 3).

---

## 1. What this is

- **Isolated**: everything lives in one `agentkit` namespace with bundled
  Postgres / MinIO / Redis on the k3s `local-path` StorageClass. No external
  data services, no phone-home to the hosted `*.agentkitproject.com` ecosystem.
- **Real TLS, no dev hacks**: browser-facing URLs are real
  `https://{forge,market,auto,dex}.tailf14b5e.ts.net` names. The Tailscale
  operator mints a Let's Encrypt cert per host. So `allowInsecure: false`
  everywhere — there is **no** `NODE_TLS_REJECT_UNAUTHORIZED=0` and **no**
  `hostAliases` (those were nip.io-quickstart dev hacks; they are gone here).
- **OIDC via bundled Dex**: a throwaway in-cluster IdP with one static user
  (`admin@example.com` / `password`). Swap it for a real IdP later by repointing
  each app's issuer/clientId/secret — see §5.
- **In-cluster service calls stay in-cluster**: Forge→Market and Auto→Market are
  server-side calls that hit the Market web Service directly
  (`http://agentkitmarket-web.agentkit.svc.cluster.local:80`), not the ts.net name.

### Layout
```
deploy/argocd-tailscale/
  root.yaml                 # app-of-apps — register THIS one
  apps/                     # child Applications, by sync-wave
    00-bootstrap.yaml       # wave 0: namespace + dex-ingress + cert-sync + coredns-rewrite
    10-dex.yaml             # wave 1: Dex (multi-source: dexidp chart + $values)
    20-forge.yaml       # wave 2: Forge WebApp
    30-market.yaml          # wave 2: Market (release name agentkitmarket)
    40-auto.yaml            # wave 2: Auto
  values/                   # Helm value overlays consumed via the $values ref
    values-dex.yaml
    values-forge.yaml
    values-market.yaml
    values-auto.yaml
  bootstrap/                # raw manifests rendered by 00-bootstrap
    namespace.yaml
    dex-ingress.yaml        # tailscale Ingress → operator mints dex cert
    cert-sync.yaml          # copies the minted cert → dex-tls Secret
    coredns-rewrite.yaml    # resolves the issuer hostname to in-cluster Dex
  secrets.example.yaml      # the plain Secrets you create (NOT committed)
```

---

## 2. Prereqs

1. **Tailscale Kubernetes operator** installed, with a **ProxyGroup named
   `admin-ingress`**. Every Ingress in this bundle uses
   `ingressClassName: tailscale` + annotation
   `tailscale.com/proxy-group: admin-ingress`, and the operator mints a
   Let's Encrypt cert Secret named `<fqdn>` in the `tailscale` namespace.
2. **ArgoCD** installed in the `argocd` namespace, with access to the public
   GitHub repos (`agentkitforge`, `agentkitmarket-core`, `agentkitauto-app`)
   and the chart repo `https://charts.dexidp.io`.
3. **Replace the tailnet suffix with YOURS.** Swap `tailf14b5e.ts.net` for your
   MagicDNS suffix across the bundle:
   ```sh
   cd deploy/argocd-tailscale
   grep -rl 'tailf14b5e.ts.net' values/ bootstrap/ \
     | xargs sed -i '' 's/tailf14b5e\.ts\.net/YOURTAILNET.ts.net/g'   # macOS sed
   ```
   This updates the Dex issuer + redirect URIs, each app's appUrl/ecosystem
   links, the CoreDNS `rewrite` line, and the `cert-sync.yaml` `SRC_NAME`
   (`dex.<tailnet>` — the operator-minted cert Secret name). The in-cluster
   `marketBaseUrl` (`...svc.cluster.local`) and the tls.hosts **shortnames**
   (`dex`/`forge`/`market`/`auto`) do **not** contain the suffix and are left
   untouched — that is correct.

   `coredns-rewrite.yaml` targets `dex.agentkit.svc.cluster.local`; if you change
   the Dex namespace or release name, fix that line too.

---

## 3. Generate secrets

There are two secret surfaces that **must agree** (app side and Dex side). Mint
three DIFFERENT client secrets plus your BYO Anthropic key:

```sh
FORGE_OIDC_CLIENT_SECRET=$(openssl rand -base64 32)
MARKET_OIDC_CLIENT_SECRET=$(openssl rand -base64 32)
AUTO_OIDC_CLIENT_SECRET=$(openssl rand -base64 32)
# ANTHROPIC_API_KEY = your own sk-ant-... key (real spend)
```

**Where each goes (both places, identical value per app):**

- **App side** — create the three plain Secrets in the `agentkit` namespace
  (`agentkitforge-secret`, `agentkitmarket-web-secret`,
  `agentkitauto-web-secret`), each with `OIDC_CLIENT_SECRET`; the Auto Secret
  also carries `ANTHROPIC_API_KEY`. See `secrets.example.yaml`. Each app's values
  file already references its Secret via `web.secrets.existingSecret`.
- **Dex side** — give Dex the SAME three secrets as `staticClients[].secret`
  (the `values/values-dex.yaml` placeholders `<FORGE/MARKET/AUTO_OIDC_CLIENT_SECRET>`).
  The cleanest way is to keep a complete, filled-in copy of `values-dex.yaml` in
  a **private repo/branch** that `apps/10-dex.yaml`'s `$values` ref points at
  (don't commit real secrets to a public repo). `secrets.example.yaml` shows the
  exact shape.

> The client secret for app X on the app side **must be byte-identical** to the
> staticClient secret for app X on the Dex side, or the token exchange fails.

---

## 4. Register

```sh
kubectl apply -f deploy/argocd-tailscale/root.yaml
```

That single root Application (`agentkit-selfhost`) renders `apps/` and the child
Applications sync in **wave order**:

- **wave 0 — bootstrap**: creates the `agentkit` namespace; applies the
  **tailscale Ingress for Dex** (which makes the operator mint the
  `dex.<tailnet>` cert); installs **cert-sync** (Job+CronJob) and the
  **CoreDNS rewrite**.
- **wave 1 — Dex**: the IdP. Its pod mounts `dex-tls`.
- **wave 2 — forge-web / market / auto**: the apps.

### The cert chicken-and-egg (it converges on its own)

1. The operator only mints the `dex.<tailnet>` cert **after** the Dex Ingress
   exists (wave 0).
2. `cert-sync.yaml`'s Job (an ArgoCD **PostSync** hook) waits up to ~5 min for
   that cert, then copies it into the `dex-tls` Secret in `agentkit`.
3. The Dex pod mounts `dex-tls`; until the Secret exists the pod can't start, so
   on a cold install Dex may briefly be Pending. ArgoCD **selfHeal** + the
   cert-sync wait reconcile this without manual steps — once `dex-tls` lands, Dex
   comes up and the wave-2 apps reach a valid OIDC issuer in-cluster.

A CronJob keeps `dex-tls` fresh across the operator's ~90-day renewals.

Watch it:
```sh
kubectl -n argocd get applications
kubectl -n agentkit get pods,ingress,secret
```
Your URLs once healthy: `https://forge.<tailnet>` · `https://market.<tailnet>` ·
`https://auto.<tailnet>` (and `https://dex.<tailnet>/dex` for the IdP).

---

## 5. User journey

### (1) Install & initial stand-up
- Do §2–§4: install operator+ArgoCD, sed your tailnet, create the secrets,
  `kubectl apply -f root.yaml`.
- Watch the waves go healthy (`kubectl -n argocd get applications`); confirm the
  three ts.net hosts resolve and serve valid TLS over your tailnet.

### (2) Setting up the org / first admin
> There is no organization-CRUD product surface yet. "Org setup" here means
> bootstrapping the first admin and (optionally) pointing at a real IdP.

- **Log in** at `https://forge.<tailnet>` as **`admin@example.com` / `password`**
  (the Dex static user). The OIDC round-trip exercises the whole chain
  (issuer → redirect → token).
- **Admin reaches the Market review queue** at `https://market.<tailnet>`. The
  admin grant is by **email** here: `values-market.yaml` sets
  `web.config.adminEmails: admin@example.com` (Dex's static connector emits no
  `groups` claim).
- **Auto** is at `https://auto.<tailnet>` (same login); runs use your BYO
  `ANTHROPIC_API_KEY`.

**Swap the test IdP for a real one** (Keycloak / Authentik / Okta / Entra / …):
- In each app's values file, repoint `web.auth.oidc.issuer` (market:
  `web.config.oidc.issuer`) and `clientId` at your company IdP, and put the real
  client secret in each app's `*-web-secret` Secret (`OIDC_CLIENT_SECRET`).
- Then you can **drop Dex entirely** (remove `apps/10-dex.yaml` and the Dex bits
  of bootstrap), since the issuer is no longer in-cluster — `coredns-rewrite.yaml`
  + `cert-sync.yaml` exist only to make the in-cluster Dex issuer reachable over
  valid TLS.
- A real IdP that emits a `groups`/`roles` claim grants Market admin by GROUP:
  `values-market.yaml` already sets `web.config.oidc.adminGroup: agentkit-admins`
  — put your admins in that group and the same overlay works unchanged.

---

## 6. Troubleshooting

**OIDC "issuer mismatch" / discovery fails from a pod.** The issuer string must
be byte-identical for browser and server, and pods must reach it over **valid
TLS**. Two pieces make that work — verify both:
- `bootstrap/coredns-rewrite.yaml` resolves `dex.<tailnet>` to the in-cluster Dex
  Service. Check it landed:
  ```sh
  kubectl -n kube-system get configmap coredns-custom -o yaml
  ```
- `bootstrap/cert-sync.yaml` copied the operator cert into `dex-tls`:
  ```sh
  kubectl -n agentkit get secret dex-tls
  kubectl -n agentkit logs job/dex-cert-sync-init
  ```
  If `dex-tls` is missing, confirm the operator minted the source cert
  (`kubectl -n tailscale get secret dex.<tailnet>`) — it only does so after the
  Dex Ingress exists.

**Verify the in-cluster discovery URL over valid TLS** (the exact path the app
pods take):
```sh
kubectl -n agentkit run dexcurl --rm -it --image=curlimages/curl:8.11.1 --restart=Never -- \
  curl -fsS https://dex.<tailnet>/dex/.well-known/openid-configuration
```
A clean 200 with no `-k` flag means CoreDNS rewrite + `dex-tls` are both correct.

**Login redirects bounce / `invalid_client`.** The app's `OIDC_CLIENT_SECRET`
(in its `*-web-secret` Secret) doesn't match the Dex `staticClients[].secret` for
that client. Make them identical (§3).

**Market admin not granted.** With the Dex test IdP, admin is by email — confirm
you logged in as `admin@example.com` and that `web.config.adminEmails` matches.
With a real IdP, ensure your user is in the `agentkit-admins` group (or add your
email to `adminEmails`).
```
