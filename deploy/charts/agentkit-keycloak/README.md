# agentkit-keycloak

**Optional** bundled [Keycloak](https://www.keycloak.org/) reference IdP for
self-hosted AgentKit.

Generic OIDC — **bring your own IdP** (Authentik, Auth0, Okta, Dex, Keycloak,
any OpenID Connect provider) — is the **first-class** contract for AgentKit
self-hosting. The apps (`market-web` / `profile-web` / `auto-web` / `forge-web`)
consume it through `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`.

This chart is a **convenience**: a batteries-included Keycloak that serves one
OIDC realm (`agentkit`) already wired for all the apps — one confidential client
per app plus a public device-flow client for the CLI. Think of it like the
bundled Postgres/MinIO in the app charts: optional and self-contained.

**Already have an IdP? Skip this chart entirely** and point each app at your IdP.

---

## What it deploys

- The official `quay.io/keycloak/keycloak` image (pinned to a 26.x stable major),
  run in production mode (`start`), `KC_PROXY_HEADERS=xforwarded`, health +
  metrics enabled, readiness on `/health/ready` (management port 9000).
- A **realm** `agentkit`, imported declaratively via `--import-realm` from a
  ConfigMap-mounted JSON, with:
  - self-registration, password reset, and (optional) email verification;
  - one **confidential** client per app (auth-code flow), redirect URI
    `<appUrl>/auth/callback`, post-logout redirect;
  - one **public** client `agentkitforge-desktop` with the OAuth 2.0 **device**
    flow enabled (for the `agentkitforge` CLI; the name is historical — the
    desktop app is retired);
  - protocol mappers so tokens carry `sub`, `email`, `name`, `given_name`,
    `family_name`, `preferred_username`, and a `groups` claim;
  - an `admins` group (in the `groups` claim) so `ADMIN_OIDC_GROUP=admins` works.
- A **database**: either a **bundled** single-node Postgres
  (`postgres.enabled=true`, for homelab/dev) or an **external** managed Postgres
  (`postgres.enabled=false` + `db.*`, for prod).
- An optional **Ingress** (host + cert-manager annotation passthrough) and an
  optional realm **SMTP** config for verification/reset emails.

---

## Quickstart

### Homelab / single-node (bundled Postgres)

```sh
helm install keycloak ./charts/agentkit-keycloak -f charts/agentkit-keycloak/values-k3s.yaml \
  --set ingress.host=auth.example.com \
  --set hostname=https://auth.example.com \
  --set realm.appUrls.market=https://market.example.com \
  --set realm.appUrls.profile=https://profile.example.com \
  --set realm.appUrls.auto=https://auto.example.com \
  --set realm.appUrls.forgeWeb=https://forge.example.com
```

The admin password, bundled-DB password, and per-app client secrets are all
chart-generated and persisted across upgrades — no `changeme` placeholders.

### Production (external managed Postgres)

```sh
helm install keycloak ./charts/agentkit-keycloak \
  --set ingress.enabled=true --set ingress.host=auth.example.com \
  --set hostname=https://auth.example.com \
  --set postgres.enabled=false \
  --set db.url="jdbc:postgresql://pg.internal:5432/keycloak" \
  --set db.username=keycloak --set db.password=... \
  --set realm.appUrls.market=https://market.example.com \
  --set realm.appUrls.profile=https://profile.example.com \
  --set realm.appUrls.auto=https://auto.example.com \
  --set realm.appUrls.forgeWeb=https://forge.example.com
```

---

## Values knobs

| Key | Default | Purpose |
|---|---|---|
| `image.repository` / `image.tag` | `quay.io/keycloak/keycloak` / `26.4` | Official Keycloak image + pinned major. |
| `hostname` | `""` | `KC_HOSTNAME` (public origin). Derived from `https://<ingress.host>` when empty. |
| `startCommand` / `optimized` | `start` / `false` | Prod start mode; `--optimized` for a prebuilt image. |
| `proxyHeaders` | `xforwarded` | `KC_PROXY_HEADERS` for ingress/LB TLS termination. |
| `admin.username` / `admin.password` | `admin` / generated | Bootstrap admin (temp; create real admins in the console). |
| `ingress.enabled` / `.host` / `.className` / `.annotations` / `.tls` | off | Optional Ingress; cert-manager annotations pass through. Empty host → tailscale defaultBackend. |
| **DB mode** | | |
| `postgres.enabled` | `false` (values.yaml) / `true` (values-k3s.yaml) | Bundled single-node Postgres vs external. |
| `postgres.image` / `.database` / `.user` / `.password` / `.storage.size` | `postgres:16.14` … / generated | Bundled-PG settings. |
| `db.url` / `db.username` / `db.password` | `""` / `keycloak` / `""` | External Postgres (JDBC). **Required** when `postgres.enabled=false`. |
| **Realm** | | |
| `realm.name` / `realm.displayName` | `agentkit` / `AgentKit` | Realm id shown in the issuer path. |
| `realm.registrationAllowed` | `true` | Self-service signup. |
| `realm.resetPasswordAllowed` | `true` | Forgot-password flow. |
| `realm.verifyEmail` | `false` | Require email verification (needs SMTP). |
| `realm.loginWithEmailAllowed` | `true` | Log in with email. |
| `realm.adminGroup` | `admins` | Group emitted in the `groups` claim → set apps' `ADMIN_OIDC_GROUP` to this. |
| `realm.appUrls.{market,profile,auto,forgeWeb}` | `""` | Public origin per app → drives that client's redirect URI. Empty ⇒ client omitted. |
| `realm.clients.{market,profile,auto,forgeWeb}.clientId` | `agentkitmarket`, `agentkitprofile`, `agentkitauto`, `agentkitforge` | Client id (must equal each app's `OIDC_CLIENT_ID`). |
| `realm.clients.*.secret` | `""` (generated) | Client secret (must equal each app's `OIDC_CLIENT_SECRET`). |
| `realm.desktopClient.enabled` / `.clientId` | `true` / `agentkitforge-desktop` | Public device-flow client for the CLI (name is historical — desktop app retired). |
| **SMTP (optional, off)** | | |
| `smtp.enabled` | `false` | Enable realm SMTP for verify/reset emails. |
| `smtp.host` / `.port` / `.from` / `.fromDisplayName` / `.ssl` / `.starttls` / `.auth` | `""` / `587` / … | Non-secret SMTP config. |
| `smtp.user` / `smtp.password` | `""` | SMTP creds → chart Secret; referenced by the realm via `${env.*}`. |
| **Secrets** | | |
| `secrets.generate` | `true` | Auto-generate + persist empty admin/DB/client secrets. |
| `secrets.existingSecret` | `""` | Source all secrets from an external Secret (see values.yaml for required keys). |
| `persistence.enabled` / `.size` | `false` / `1Gi` | Small convenience PVC for `/opt/keycloak/data`. |
| **In-cluster HTTPS (optional, off)** | | |
| `https.enabled` | `false` | Serve HTTPS in-cluster **in addition to** HTTP (additive; the HTTP port is always kept). |
| `https.port` | `8443` | HTTPS container port → adds a `https` container port and a `https` Service port. |
| `https.certificateFile` / `.certificateKeyFile` | `""` | Paths to the TLS cert/key PEM in the container (→ `KC_HTTPS_CERTIFICATE_FILE` / `KC_HTTPS_CERTIFICATE_KEY_FILE`). Point at an `extraVolumeMount`. |
| **Extensibility (all default empty → output unchanged)** | | |
| `extraEnv` | `[]` | Raw env entries (`name`/`value` or `name`/`valueFrom`) appended to the Keycloak container `env`. |
| `extraVolumes` | `[]` | Extra pod volumes appended to `spec.volumes` (e.g. a TLS cert Secret). |
| `extraVolumeMounts` | `[]` | Extra container `volumeMounts` (mount the volumes above, e.g. at `/etc/keycloak/tls`). |

### In-cluster HTTPS (tailnet in-cluster IdP)

By default this chart terminates TLS at the ingress and serves plain HTTP inside
the cluster — the standard reverse-proxy pattern. For a **tailnet "in-cluster
IdP"** pattern where app pods reach the issuer **FQDN directly** (no public /
internal host split) and OIDC discovery therefore needs a valid TLS cert on the
in-cluster endpoint, Keycloak can serve HTTPS itself from a mounted cert Secret:

```sh
helm upgrade --install keycloak ./charts/agentkit-keycloak -f charts/agentkit-keycloak/values-k3s.yaml \
  --set https.enabled=true \
  --set https.certificateFile=/etc/keycloak/tls/tls.crt \
  --set https.certificateKeyFile=/etc/keycloak/tls/tls.key \
  --set-json 'extraVolumes=[{"name":"kc-tls","secret":{"secretName":"keycloak-tls"}}]' \
  --set-json 'extraVolumeMounts=[{"name":"kc-tls","mountPath":"/etc/keycloak/tls","readOnly":true}]'
```

This is **additive**: the plain HTTP port is always kept (browser path via HTTP
behind the TLS-terminating ingress), and a second `https` port (default `8443`)
is added to both the container and the Service. Keycloak serves both HTTP and
HTTPS once the `KC_HTTPS_CERTIFICATE_FILE` env is set. `extraEnv` / `extraVolumes`
/ `extraVolumeMounts` are generic escape hatches — with their defaults (all
empty, `https.enabled=false`) the rendered manifests are unchanged.

### How realm import is wired

`templates/realm-configmap.yaml` renders the whole realm (clients, redirect URIs
derived from `realm.appUrls`, protocol mappers, the `admins` group, the device
client, and optional SMTP) to JSON with `toJson`, into a ConfigMap. The
Deployment mounts it read-only at `/opt/keycloak/data/import` and runs with
`--import-realm`, which the official image applies on boot. A
`checksum/realm` pod annotation rolls Keycloak when the import changes. Client
secrets baked into the JSON are the **same** effective values written into the
chart Secret (`CLIENT_SECRET_<CLIENTID>`), so they always match what you wire
into the apps.

---

## Integration — pointing the apps at this Keycloak (OPTIONAL)

> Skip this whole section if you use your own IdP; just set the apps'
> `OIDC_*` values to your IdP instead.

For **each** app chart (`agentkitmarket`, `agentkitprofile`, `agentkitauto`,
`agentkitforge`), set the web tier to generic OIDC and point it at this realm:

```yaml
web:
  authProvider: "oidc"          # AUTH_PROVIDER=oidc
  config:
    appUrl: "https://market.example.com"
    oidc:
      issuer: "https://auth.example.com/realms/agentkit"   # OIDC_ISSUER
      clientId: "agentkitmarket"                            # OIDC_CLIENT_ID (per app, below)
      adminGroup: "admins"                                  # ADMIN_OIDC_GROUP (Market)
      # redirectUri defaults to "<appUrl>/auth/callback" — matches the realm client.
  secrets:
    oidcClientSecret: "<CLIENT_SECRET_… from this chart>"   # OIDC_CLIENT_SECRET (must match)
    # sessionSecret left empty → the app chart generates + persists SESSION_SECRET.
```

- **Issuer** (all apps): `https://<keycloak-host>/realms/agentkit`
  (serves `/.well-known/openid-configuration`).
- **Client id per app** (match the realm client ids):

  | App | `OIDC_CLIENT_ID` | Redirect URI |
  |---|---|---|
  | Market | `agentkitmarket` | `<appUrl>/auth/callback` |
  | Profile | `agentkitprofile` | `<appUrl>/auth/callback` |
  | Auto | `agentkitauto` | `<appUrl>/auth/callback` |
  | Web Forge | `agentkitforge` | `<appUrl>/auth/callback` |

- **Client secret**: `OIDC_CLIENT_SECRET` must equal the realm client's secret.
  Read the generated value from this chart's Secret, e.g. for Market:

  ```sh
  kubectl -n <ns> get secret <release>-secret \
    -o jsonpath='{.data.CLIENT_SECRET_AGENTKITMARKET}' | base64 -d ; echo
  ```

  (Keys: `CLIENT_SECRET_AGENTKITMARKET`, `CLIENT_SECRET_AGENTKITPROFILE`,
  `CLIENT_SECRET_AGENTKITAUTO`, `CLIENT_SECRET_AGENTKITFORGE`.) Or pin your
  own secrets via `realm.clients.*.secret` and set the same value on each app.

- **`AUTH_PROVIDER=oidc`** and **`SESSION_SECRET`**: set `web.authProvider: oidc`
  on each app chart; leave `web.secrets.sessionSecret` empty to let the app chart
  auto-generate + persist `SESSION_SECRET`.
- **Admin gating** (Market): add users to the `admins` group in Keycloak and set
  `ADMIN_OIDC_GROUP=admins` (via `web.config.oidc.adminGroup`).
- **CLI Forge** (`agentkitforge market login`): uses the public
  `agentkitforge-desktop` client with the OAuth 2.0 device flow against the same
  realm issuer.

This chart does **not** modify any app chart — wire the values above yourself.
