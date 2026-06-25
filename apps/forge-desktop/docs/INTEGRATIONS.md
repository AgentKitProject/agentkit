# Integrations

AgentKitForge is local-first. The desktop app remains fully usable without an AgentKitProject account.

Signed-out users can create, edit, validate, package, export, import, and use local Agent Kits. Build with AI continues to use local provider settings and locally stored provider API keys.

## AgentKitProject Account

AgentKitProject account and profile UX lives at:

```text
https://profile.agentkitproject.com/account
```

The Forge app includes a top-level Account view and a persistent account status block at the bottom of the sidebar. Signed-out users see **Not signed in** and can open the Account view from anywhere in the app.

Desktop account connection uses WorkOS/AuthKit device-code auth when the app build includes the public `AGENTKITPROJECT_WORKOS_CLIENT_ID`. This public client ID can be supplied as a runtime environment variable for dev launches or as a compile-time environment variable during `tauri build` for packaged apps. It is not read from Vite frontend env and is not stored in local settings. Device-code auth is preferred over a localhost callback because WorkOS supports it for CLI-style clients, it uses the system browser, and it does not require an embedded client secret or webview. The Account view shows the user code and verification URL returned by WorkOS, opens the verification URL in the system browser, and polls at the interval requested by WorkOS until the user approves, denies, or the code expires.

The private device code and resulting tokens stay in the Rust backend. The desktop app stores the account session in OS secure storage and stores only non-sensitive display metadata in local settings. Tokens, auth codes, refresh tokens, and device codes must not be logged or written to plaintext settings JSON.

Forge treats connected account state as valid only when both public account metadata and a usable secure-storage session are present. If local settings still contain display metadata but the secure token/session is missing or unreadable, Forge marks the account reconnect-required instead of showing it as connected. Hosted Market direct import returns a reconnect-required error in that case and the UI shows a reconnect CTA while keeping all local workflows available.

On macOS, `npm run dev` and an installed signed app can have different Keychain access identity even though Forge uses the same stable service/account identifiers (`com.agentkitforge.desktop.agentkitproject` / `agentkitproject-session`). If a session was created by the installed app and a dev build cannot replace or read it back, disconnect/reconnect from the same build you are testing, or remove the old AgentKitProject Keychain item before retrying.

If a build does not include the public WorkOS client ID, Forge does not fake connected state. The Account view keeps the user disconnected and reports that the safe public key `AGENTKITPROJECT_WORKOS_CLIENT_ID` is missing. The Account view can still open the AgentKitProject account page in the system browser.

Disconnect clears the secure stored AgentKitProject session and public account metadata. It does not delete local kits, My Kits entries, AI provider settings, provider API keys, or local app data.

## External Service Connections

Forge models optional services as external service connections instead of assuming every integration uses AgentKitProject credentials. A connection records public metadata such as service type, base URL, hosted/self-hosted kind, auth mode, status, display user, and advertised capabilities. Secrets are not part of this public settings model.

Hosted AgentKitProject services use the optional AgentKitProject account. Private or self-hosted Market and Auto services use their own credentials and identity provider. Users should not need AgentKitProject credentials to access their own company/private services unless that service explicitly chooses AgentKitProject as its auth provider.

Credential rules:

- credentials are scoped per service connection
- tokens and API keys must be stored in OS secure storage/keychain
- normal app settings may store only public connection metadata
- disconnect clears credentials for that service only
- tokens, API keys, auth headers, and prompts must not be written to plaintext settings or logs

## Optional Services

AgentKitMarket is available to browse at:

```text
https://market.agentkitproject.com/kits
```

Forge includes optional hosted Market browse, direct import, direct submit, and manual-import paths. The app can open AgentKitMarket in the system browser, then users can download a `.agentkit.zip`, return to Forge, and import it through **Import -> From .agentkit.zip**. Downloading from Market may require an AgentKitProject account, but importing a downloaded local package in Forge does not require login.

Signed-in users can directly import approved hosted AgentKitMarket kits by URL, slug, or kit ID. Forge calls:

```text
POST https://market.agentkitproject.com/api/forge/kits/{slug}/download
```

with `Authorization: Bearer <AgentKitProject token>`. Forge must not send admin keys, service keys, local kit data, prompts, or provider credentials. The response returns a short-lived package download URL plus package metadata such as file name, version, sha256, size, and expiry. Forge downloads the package to an app-controlled temporary location, verifies `.agentkit.zip` naming and sha256 when provided, validates the package locally, extracts it into the default Forge library, adds it to My Kits with `source = market`, and records public Market metadata such as `marketBaseUrl`, slug, kit id, version, sha256, and imported time.

Forge treats Market listing lifecycle states as display/error signals from hosted Market, not as local business logic. If hosted Market reports `removed`, `withdrawn`, or `hidden`, Forge shows that the kit listing is no longer available in AgentKitMarket. If hosted Market reports `expired`, `deleted`, `archived`, or not found, Forge shows that the Market listing is no longer available. Auth failures still ask the user to connect/reconnect, and forbidden access shows an access-denied message instead of a reconnect prompt.

Market-downloaded `.agentkit.zip` packages can be imported manually through the local Import view without signing in. Manual package import validates the archive locally, blocks unsafe zip paths, computes local package metadata/checksums when practical, and does not call Market APIs. Package contents are not executed during import.

Market can also launch Forge with reference-only deep links:

```text
agentkitforge://market/import?market=<encoded-market-base-url>&kit=<slug-or-public-id>
agentkitforge://market/import?market=<encoded-market-base-url>&kitId=<kit-id>
```

The deep link route is `agentkitforge://market/import`. `market` is required and must be HTTPS except for localhost development URLs. One of `kit` or `kitId` is required. Deep links must not include `downloadUrl`, bearer tokens, auth parameters, admin keys, service keys, signed S3 URLs, or other secrets. Forge opens the Import -> Market view, pre-fills the Market source and kit identifier, and asks the user to confirm before requesting a download.

Signed-in users can submit local kits to hosted AgentKitMarket from Forge. Forge validates the kit locally first, packages it as `.agentkit.zip`, computes sha256, and calls:

```text
POST https://market.agentkitproject.com/api/forge/submissions/upload-url
```

with `Authorization: Bearer <AgentKitProject token>` and public listing draft metadata derived from the selected kit. Market returns `submissionId`, `uploadUrl`, and optional `method`, `fields`, and `headers`. Forge then uploads the `.agentkit.zip` directly to that `uploadUrl` using PUT, or POST multipart when form fields are returned, and starts Market validation with:

```text
POST https://market.agentkitproject.com/api/forge/submissions/{submissionId}/validate
```

Forge must not send admin keys, service keys, prompts, provider credentials, or local kit data unrelated to the selected package. Signed upload URLs are used only for the immediate package upload and are never passed through deep links. The Market response returns or implies a submission id, status, and Market link. Publishing is not automatic: hosted Market validation and admin review remain authoritative, and Forge only reports the created submission.

The hosted Market backend currently names its publisher field `publisherId`, but Forge must populate that value with the connected AgentKitProfile display name. Forge must not submit raw WorkOS ids, internal user ids, emails, kit ids, slugs, or arbitrary publisher ids as publisher identity.

These hosted submit endpoints must accept the same Forge bearer/device-auth session used by `POST /api/forge/kits/{slug}/download`. If Market returns a browser/AuthKit cookie-only `401` such as `{"message":"Sign in is required."}` while Forge has already attached the device bearer token, Forge reports that hosted Market submit does not accept Forge device-auth sessions yet. The correct fix is a Market-side Forge-compatible submission route, not adding admin/service credentials to Forge.

Submission status display should preserve hosted Market's canonical lifecycle values. Forge currently prepares display labels for `pending`, `validating`, `validation_failed`, `approved`, `rejected`, `published`, `canceled`, `removed`, `deleted`, `expired`, and `archived`; status transitions and review rules remain owned by Market.

AgentKitAuto connection is an optional future integration and is not required for local Forge use. Forge must not embed `AGENTKITMARKET_ADMIN_KEY`, `PROFILE_SERVICE_KEY`, WorkOS API keys, or other service/admin secrets.

Private/self-hosted Market placeholders are supported in the UI model. Private markets use their own credentials and identity provider. An AgentKitProject account is not required unless that market chooses it. Private Market direct import and submit are coming later and must use the selected private Market connection rather than hosted AgentKitProject auth.

Hosted AgentKitAuto is reserved for a future optional AgentKitProject service. Private/self-hosted Auto placeholders are supported in the UI model and will use their own credentials and identity provider. Auto connections are optional and must not run automatically on startup.

Capability checks are intentionally conservative:

- local Forge features are always available
- manual Market package import is always available for local `.agentkit.zip` files
- hosted Market direct import requires a connected AgentKitProject account
- hosted Market submit requires a connected AgentKitProject account and creates an admin-review submission
- private Market direct import requires that private Market's own future connection, while local package import stays available
- Auto requires an explicit future Auto connection

## Discovery

Future self-hosted services may advertise their public connection metadata through well-known discovery documents. These endpoints are planned, not required today:

```text
GET /.well-known/agentkit-market.json
GET /.well-known/agentkit-auto.json
```

Example discovery fields:

```json
{
  "name": "Company AgentKitMarket",
  "apiBaseUrl": "https://market.company.example/api",
  "auth": {
    "mode": "oidc",
    "issuer": "https://identity.company.example",
    "clientId": "public-desktop-client-id",
    "scopes": ["openid", "profile", "agentkit.market"]
  },
  "capabilities": {
    "browse": true,
    "download": true,
    "submit": true,
    "import": true,
    "privateCatalog": true
  }
}
```

## Domains

The canonical Forge domain is:

```text
https://forge.agentkitproject.com
```

The legacy `https://agentkitforge.com` domain remains supported during the domain transition, including for installed apps that still use the old updater endpoint.
