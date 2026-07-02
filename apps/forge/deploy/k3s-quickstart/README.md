# AgentKit self-host k3s quickstart (with a bundled IdP)

Stand up the **entire self-hosted AgentKit stack** — AgentKitForge WebApp +
AgentKitMarket — on a homelab **k3s** node and test the **full OIDC login flow**,
starting from **nothing**: no existing identity provider, no DNS, no cloud.

This bundle adds the one thing the per-app self-host charts assume you already
have: an **OIDC IdP**. It bundles a throwaway in-cluster [**Dex**](https://dexidp.io)
with a single static test user, then layers thin overlays onto each app's own
`values-k3s.yaml` preset so all three pieces point at each other.

- **Zero DNS** — hostnames are [`nip.io`](https://nip.io) wildcards that resolve
  to your node IP (`forge.192.168.1.50.nip.io` → `192.168.1.50`).
- **k3s defaults** — Traefik `IngressClass`, `local-path` storage, ServiceLB.
- **No phone-home** — Market is your own in-cluster Market; nothing talks to
  `*.agentkitproject.com`. (There's a verification step below.)

> ⚠️ **Test bundle, not production.** Dex uses in-memory storage and a static
> password; Traefik serves a self-signed TLS cert. To make the 6-step flow reach
> a Dex login with **zero TLS/DNS fiddling**, the two overlays bake in two
> dev-only settings (TLS-verification skip + `hostAliases`) — see
> **[Smoke test (dev TLS)](#smoke-test-dev-tls)**. See **TLS** and **Going to
> production** at the bottom before any real rollout.

## What's in here

| File | Purpose |
|---|---|
| `dex/dex-values.yaml` | Dex Helm values: issuer, the static test user, 3 OIDC clients. Client secrets are `<…>` placeholders filled by `gen-secrets.sh`. |
| `values-forge.yaml` | Overlay on the **forge-web** chart's `values-k3s.yaml`: OIDC→Dex, ingress host, `appUrl`, `marketBaseUrl`→our Market, `autoUrl`→our Auto. |
| `values-market.yaml` | Overlay on the **market** chart's `values-k3s.yaml`: OIDC→Dex, ingress host, `adminEmails`/`adminGroup`. |
| `values-auto.yaml` | Overlay on the **agentkitauto** chart's `values-k3s.yaml`: OIDC→Dex, ingress host, `appUrl`, `marketBaseUrl`→our Market, k8s worker dispatch ON. |
| `secrets.example.yaml` | The shape of the secret overlays (reference only). |
| `gen-secrets.sh` | Generates the 3 Dex client secrets + session/admin secrets and writes the `*.generated.yaml` files. |
| `.gitignore` | Keeps the generated secret files out of git. |

The charts themselves live in three repos (referenced by relative path below):

- forge-web: `../../charts/agentkitforge` (this repo)
- market: `../../../agentkitmarket-core/charts/agentkitmarket` (sibling repo)
- auto: `../../../agentkitauto-app/charts/agentkitauto` (sibling repo)

## Prerequisites

- A reachable **k3s** node and its IP (`kubectl get nodes -o wide`). Call it `NODE_IP`.
- `helm` 3.8+, `kubectl`, `openssl`, and the **Dex** chart repo:
  ```sh
  helm repo add dex https://charts.dexidp.io && helm repo update dex
  ```
- The three chart repos checked out as **siblings** of this repo
  (`agentkitforge`, `agentkitmarket-core`, and `agentkitauto-app` in
  the same parent dir).
- For AgentKitAuto runs: a **BYO `ANTHROPIC_API_KEY`** (the Auto worker uses it
  for inference) and a cluster that can pull the public Auto images.

## Clone → login, in 7 steps

```sh
cd agentkitforge/deploy/k3s-quickstart
```

### 1. Set your node IP everywhere (the ONE placeholder)

`<NODE_IP>` is the only thing you edit. Substitute it across the four committed
value files (in place — your clone is disposable):

```sh
NODE_IP=192.168.1.50            # <-- your k3s node IP
sed -i '' "s/<NODE_IP>/$NODE_IP/g" \
  dex/dex-values.yaml values-forge.yaml values-market.yaml values-auto.yaml
# (GNU sed: drop the '' after -i)
```

This yields the hostnames:
`dex.$NODE_IP.nip.io`, `forge.$NODE_IP.nip.io`, `market.$NODE_IP.nip.io`,
`auto.$NODE_IP.nip.io`.

### 2. Generate secrets

```sh
./gen-secrets.sh
```

Mints the **three** Dex client secrets (one per app — they differ), plus the
session/encryption/admin secrets, and writes:
`dex/dex-values.generated.yaml`, `secrets.forge.generated.yaml`,
`secrets.market.generated.yaml`, `secrets.auto.generated.yaml` (all git-ignored).

### 3. Install Dex (the IdP)

```sh
helm install dex dex/dex --version 0.24.1 \
  -f dex/dex-values.generated.yaml \
  --namespace agentkit --create-namespace
```

### 4. Install Market

```sh
helm install agentkitmarket ../../../agentkitmarket-core/charts/agentkitmarket \
  -f ../../../agentkitmarket-core/charts/agentkitmarket/values-k3s.yaml \
  -f values-market.yaml \
  -f secrets.market.generated.yaml \
  --namespace agentkit
```

### 5. Install Forge WebApp

```sh
helm install agentkitforge ../../charts/agentkitforge \
  -f ../../charts/agentkitforge/values-k3s.yaml \
  -f values-forge.yaml \
  -f secrets.forge.generated.yaml \
  --namespace agentkit
```

### 6. Install AgentKitAuto

AgentKitAuto is a **separate app** — its chart lives in the sibling
`agentkitauto-app` repo. Supply your **BYO `ANTHROPIC_API_KEY`** (the Auto
worker uses it for inference); the worker service key is chart-generated.

```sh
helm install agentkitauto \
  ../../../agentkitauto-app/charts/agentkitauto \
  -f ../../../agentkitauto-app/charts/agentkitauto/values-k3s.yaml \
  -f values-auto.yaml \
  -f secrets.auto.generated.yaml \
  --set auto.anthropicApiKey=sk-ant-... \
  --namespace agentkit
```

Each Auto run becomes a one-shot Kubernetes Job in the `agentkit` namespace
(`AUTO_DISPATCH=k8s`); a per-minute CronJob sweeps due schedules. The web pod's
ServiceAccount gets namespaced RBAC to create those Jobs (see the chart's
`auto-rbac.yaml`).

### 7. Log in

Wait for pods, then open Forge in a browser:

```sh
kubectl -n agentkit get pods
# open https://forge.<NODE_IP>.nip.io  (accept the self-signed cert — see TLS)
```

Click **Sign in** → you're redirected to Dex → log in with:

| | |
|---|---|
| **Email** | `admin@example.com` |
| **Password** | `password` |

You land back in Forge, authenticated. Repeat at
`https://market.<NODE_IP>.nip.io` — the same user signs in and is a Market
**admin** (granted by `adminEmails`; see **Admin access**). Forge's
`marketBaseUrl` points at this Market, so import/favorites resolve against it,
and Forge links out to Auto at `https://auto.<NODE_IP>.nip.io`. The same user
also signs in at the Auto app and can launch autonomous runs (its
`marketBaseUrl` resolves kits against the same Market).

## Smoke test (dev TLS)

To make the flow above work out-of-the-box on a single-node k3s — with
Traefik's self-signed cert and `nip.io` hosts, **no manual TLS or DNS work** —
all three overlays (`values-forge.yaml`, `values-market.yaml`,
`values-auto.yaml`) ship two **dev-only** settings on the web pods (the Next.js
pods that do server-to-server OIDC):

1. **TLS-verification skip** — `web.extraEnv` sets `NODE_TLS_REJECT_UNAUTHORIZED=0`.
   The apps do server-to-server OIDC discovery against the Dex issuer
   (`https://dex.<NODE_IP>.nip.io/dex`), but Traefik's default cert is self-signed,
   so the Node process would otherwise reject it. This blunt flag makes Node
   accept the self-signed cert for the smoke test.
2. **`hostAliases` for hairpin** — `web.hostAliases` maps the `dex`, `forge`,
   `market`, and `auto` `.nip.io` hosts straight to `<NODE_IP>`, so the pods
   reach the ingress without depending on CNI hairpin DNS quirks.

Together these remove the two usual blockers (cert verification + hairpin), so the
flow reaches the Dex login unaided. **The browser still shows a one-time
self-signed-cert warning** at `https://forge.<NODE_IP>.nip.io` (and Dex/Market) —
click through; that's expected for the smoke test.

These are marked `DEV/SMOKE-TEST ONLY` in all three overlays and are **off by default**
in the charts (`web.extraEnv: []`, `web.hostAliases: []`). The **production path**
is real certs via **cert-manager** + a `ClusterIssuer` and **dropping**
`NODE_TLS_REJECT_UNAUTHORIZED` entirely (see **[Self-signed TLS](#self-signed-tls-traefik-default-cert)**
and **Going to production**).

## How the three pieces fit together

```
  browser ──https──> Traefik ingress ─┬─> forge.<IP>.nip.io  (forge-web)
                                       ├─> market.<IP>.nip.io (market web)
                                       └─> dex.<IP>.nip.io/dex (Dex IdP)

  forge-web / market web  ──OIDC discovery + token verify──>  dex.<IP>.nip.io/dex
        (issuer = the SAME public URL the browser uses — see issuer pitfall)

  forge-web  ──AGENTKITMARKET_BASE_URL──>  https://market.<IP>.nip.io
```

- **Dex issuer** = `https://dex.<NODE_IP>.nip.io/dex` — used by **both** the
  browser and the pods. Two static clients: `agentkitforge` (redirect
  `https://forge.<IP>.nip.io/auth/callback`) and `agentkitmarket` (redirect
  `https://market.<IP>.nip.io/auth/callback`), each with its own secret.
- **Forge ↔ Market**: `values-forge.yaml` sets
  `web.config.marketBaseUrl: https://market.<IP>.nip.io` and
  `disableMarket: false`, so the self-hosted Forge integrates with the
  self-hosted Market — no hosted-ecosystem calls.

## Admin access

A Market admin is granted when **either** the OIDC token carries the
`adminGroup` (`ADMIN_OIDC_GROUP=agentkit-admins`) **or** the email is in
`adminEmails`. Dex's **static-password connector cannot emit a `groups` claim**,
so for this test IdP the admin is granted by **email**
(`adminEmails: admin@example.com`, set in `values-market.yaml`). The `adminGroup`
is still wired end-to-end, so the **same overlay** grants admin by group against
a real IdP (Keycloak/Authentik/Entra/…) that emits groups — just put your user
in `agentkit-admins` there.

## Verify there is NO egress to the hosted ecosystem

The whole point of self-host is no phone-home. Confirm nothing resolves or calls
`*.agentkitproject.com`:

```sh
# 1. No agentkitproject.com URLs in the rendered config of either app:
helm template agentkitforge ../../charts/agentkitforge \
  -f ../../charts/agentkitforge/values-k3s.yaml -f values-forge.yaml \
  | grep -i agentkitproject.com || echo "OK: no agentkitproject.com in forge-web config"

helm template agentkitmarket ../../../agentkitmarket-core/charts/agentkitmarket \
  -f ../../../agentkitmarket-core/charts/agentkitmarket/values-k3s.yaml -f values-market.yaml \
  | grep -i agentkitproject.com || echo "OK: no agentkitproject.com in market config"

# 2. At runtime, watch egress from the web pod (should only hit the Dex/Market
#    nip.io hosts and in-cluster services, never *.agentkitproject.com):
kubectl -n agentkit exec deploy/agentkitforge -- \
  sh -c 'getent hosts forge.'"$NODE_IP"'.nip.io; getent hosts api.workos.com 2>&1 || echo "no workos resolution path needed"'
```

`SELF_HOST=true` (set automatically by `AUTH_PROVIDER=oidc`) keeps Market off
unless you explicitly point `marketBaseUrl` at your own Market (which we do).

## Troubleshooting

### OIDC issuer mismatch / "issuer did not match" / discovery fails from the pod
OIDC requires the discovery document's `issuer` to **byte-match** the configured
issuer, so we use **one** public issuer (`https://dex.<IP>.nip.io/dex`) for both
the browser and the pods — do **not** split it into a separate in-cluster URL.

That means **pods must reach the ingress URL**. The forge/market overlays
already bake in `web.hostAliases` mapping the three nip.io hosts to `<NODE_IP>`
(see [Smoke test (dev TLS)](#smoke-test-dev-tls)), so the web pods don't depend
on hairpin NAT. **Dex** itself still relies on hairpin; if a pod (e.g. Dex) can't
reach `https://dex.<IP>.nip.io/dex` (CNI without hairpin NAT), add a `hostAliases`
entry so the hostname resolves to the node IP from inside the pod — e.g. for
Dex add to `dex/dex-values.yaml`:

```yaml
hostAliases:
  - ip: "<NODE_IP>"
    hostnames: [ "dex.<NODE_IP>.nip.io" ]
```

…and add the equivalent on the forge/market deployments (via the chart's pod
spec, or a CoreDNS `rewrite`/`hosts` entry mapping the three nip.io hosts to the
node IP cluster-wide). A CoreDNS hosts block is the cleanest cluster-wide fix:

```
# in the coredns Corefile
hosts {
  <NODE_IP> dex.<NODE_IP>.nip.io forge.<NODE_IP>.nip.io market.<NODE_IP>.nip.io
  fallthrough
}
```

### Self-signed TLS (Traefik default cert)
The nip.io hosts have **no real certificate** — Traefik serves its built-in
self-signed cert. Browsers show a warning (click through for testing). More
importantly, the **pods** verifying Dex's HTTPS issuer may reject the
self-signed cert.

For the smoke test this is **already handled**: both overlays set
`NODE_TLS_REJECT_UNAUTHORIZED=0` on the web pods (see
[Smoke test (dev TLS)](#smoke-test-dev-tls)), so OIDC discovery succeeds against
the self-signed issuer with no extra work. For a **real** deployment, drop that
flag and pick one of the proper options below, easiest first:

1. **Trust the Traefik CA in the pods** (mount it and set `NODE_EXTRA_CA_CERTS`),
   or
2. **Issue real certs** with cert-manager + a `ClusterIssuer` (Let's Encrypt
   needs the nip.io hosts to be publicly reachable on :80/:443), or
3. **Dev-only insecure**: set the apps' `…oidc.allowInsecure: true` and run Dex
   over plain HTTP behind the ingress (issuer `http://…`) — acceptable only for
   throwaway testing, never with a real IdP.

For a pure homelab smoke test, (1) or (3) is fastest.

### Pods CrashLoopBackOff on first boot
Postgres/MinIO take a few seconds; the web pods retry. Check
`kubectl -n agentkit logs deploy/agentkitforge`.

## Going to production

Swap Dex's `staticPasswords` for a real connector (LDAP/SAML/upstream OIDC) or
replace Dex entirely with Keycloak/Authentik/your IdP — the app overlays only
need `issuer`/`clientId`/`clientSecret` updated. Use `storage.type: postgres`
for Dex (not `memory`), real TLS certs, and pin every image to a release tag
(`web.image.tag`, `image.tag`).

## What gets decided by YOU

- **TLS for the nip.io hosts** — this bundle ships **no** cert (Traefik
  self-signed). Pick option 1/2/3 under **Self-signed TLS** above before a real
  rollout. For a smoke test the self-signed cert is fine.
- **Hairpin reachability** — if your CNI can't hairpin to the node IP, apply the
  CoreDNS/hostAliases fix above.
