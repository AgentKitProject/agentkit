# agentkitforge-web

Phase 1 of the **AgentKitForge WebApp** port: a Next.js 15 (App Router) backend
that runs [`@agentkitforge/core`](https://www.npmjs.com/package/@agentkitforge/core)
**server-side** behind HTTP endpoints, so a future web UI (Phase 2) can do
everything the desktop Forge app does without a local filesystem.

`@agentkitforge/core` is **Node-only** — it runs server-side exclusively and is
**never** imported into a client component.

## How it works

- **Auth**: WorkOS AuthKit cookie sessions (mirrors `agentkitmarket-app`). Web
  Forge is logged-in by design; every `/api/*` route requires an authenticated
  user (`requireUserForApi`) and is scoped to that user's id.
- **KitStore** (`server/store/types.ts`): persists each user's kits as a *file
  tree* + metadata, since there is no local FS. Favorites are **references** to
  Market kits (slug + cached display metadata), never copies. One adapter ships
  today: **LocalDiskKitStore** (`server/store/local-disk.ts`), under
  `AGENTKITFORGE_WEB_DATA_DIR`. S3+DynamoDB (hosted) and Postgres+MinIO
  (self-host) adapters are stubbed with TODOs.
- **Core runner** (`server/core/runner.ts`): for each operation it materializes
  the kit tree into an ephemeral `os.tmpdir` dir, runs the relevant core
  function against it, persists any mutated tree back to the KitStore, and
  **always** cleans up (`try/finally`). Package/export return bytes/text for web
  download instead of writing to a user path.

## API routes (mapped to the desktop `ForgeClient`)

| Route | ForgeClient op |
|---|---|
| `GET /api/kits` | `listMyKits` |
| `POST /api/kits/from-template` | `createAgentKitFromTemplate` |
| `POST /api/kits/from-draft` | `renderGeneratedAgentKitDraft` |
| `GET/DELETE /api/kits/:id` | `getAgentKitMetadata` / `removeKitFromLibrary` |
| `GET /api/kits/:id/tree` | (read file tree for editor) |
| `PUT/DELETE /api/kits/:id/files` | write/delete kit file |
| `POST /api/kits/:id/validate` | `validateAgentKit` |
| `POST /api/kits/:id/package` | `packageAgentKit` (zip bytes) |
| `POST /api/kits/:id/export/onefile` | `exportAgentKitOneFile` (text) |
| `POST /api/kits/:id/export/codex` | `exportAgentKitToCodex` (zip) |
| `POST /api/kits/:id/export/claude-code` | `exportAgentKitToClaudeCode` (zip) |
| `GET /api/kits/:id/summary` | `getAgentKitSummary` |
| `GET /api/kits/:id/next-version` | `nextAgentKitVersion` |
| `GET /api/kits/:id/draft` | `loadAgentKitAsDraft` |
| `GET /api/kits/:id/prepared-prompts` | `listPreparedPrompts` |
| `POST /api/kits/:id/prepared-prompts/render` | `renderPreparedPrompt` |
| `POST /api/drafts/generate` | `generateAgentKitDraftWithAi` |
| `POST /api/drafts/revise` | `reviseAgentKitDraftWithAi` |
| `POST /api/import/zip` | `importAgentKitPackage` |
| `POST /api/import/git` | `importAgentKitFromGit` |
| `POST /api/import/market` | `importHostedMarketKit` |
| `GET/POST/DELETE /api/favorites` | favorites (Market refs) |
| `GET /api/kits/update-check` | `checkKitUpdate` (read-only, tokenless) |
| `GET /api/settings` · `POST /api/settings` | app settings / preferences |
| `GET/PUT /api/settings/ai-providers` | per-user AI providers (list/save/remove/default) |
| `POST/DELETE /api/settings/ai-provider` | `saveAiProvider` / `removeAiProvider` |
| `POST /api/settings/ai-provider/default` | `setDefaultAiProvider` |
| `POST /api/settings/ai-provider/test` | `testAiProviderConnection` |
| `POST/DELETE /api/settings/openai-key` | `saveOpenAiApiKey` / `clearOpenAiApiKey` |
| `POST /api/market/submit` | `submitHostedMarketKit` (WorkOS bearer from cookie session) |
| `POST /api/market/licensed` | `fetchLicensedMarketKit` (in-memory preview; entitled via bearer) |
| `GET /health` | health check (public) |

### Per-user AI providers & Market auth

- **AI provider settings** are stored per user server-side (`server/store/user-settings.ts`).
  API keys are **encrypted at rest with AES-256-GCM** when `AGENTKITFORGE_WEB_SECRET`
  is set (a 32-byte hex/base64 key or any passphrase); without it, keys are stored
  in plaintext and a one-time warning is logged. The GET surface never returns keys
  (only `hasApiKey`). AI draft generate/revise resolve the **current user's** provider
  config (default or explicit `providerId`), not a single server env var.
- **Hosted-Market submit / entitled downloads** authenticate to Market's `/api/forge/*`
  routes with a **WorkOS bearer access token**. The web user has an AuthKit *cookie*
  session, so `server/core/market-auth.ts` reads the WorkOS access token from
  `withAuth()` and wraps it in a `TokenStore` that the core market client consumes
  (forwarded as the bearer token). The same store powers entitled/private licensed
  downloads. No automatic publishing — admin review is always required.

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in WorkOS + AI provider values
npm run dev                  # http://localhost:3000  (/health is public)
```

## Verify

```bash
npm run typecheck
npm run build      # normal build (do NOT set BUILD_STANDALONE)
npm test           # vitest: KitStore adapter + core-runner round-trip + WebForgeClient mapping
```

## Self-host (Docker)

```bash
docker build -t agentkitforge-web .   # builds with BUILD_STANDALONE=1
docker run -p 3000:3000 --env-file .env.local -v akf-data:/data agentkitforge-web
```

The image needs `git` (for `/api/import/git`) — already installed. Mount a
volume at `/data` so kit trees persist.

## Phase 2 — Web UI + WebForgeClient

Phase 2 adds the browser frontend at **`/forge`** (AuthKit-gated), built over the
same `ForgeClient` seam the desktop app uses.

### `WebForgeClient` (`forge-client/`)

`forge-client/web-client.ts` implements the **same `ForgeClient` interface** as the
desktop `TauriForgeClient`. The interface is **replicated** in
`forge-client/types.ts` (not imported from the desktop repo): the desktop type
module statically imports `@tauri-apps/plugin-updater` and pulls result types from
the 11977-line `App.tsx`, neither installable here. **Keep method signatures in sync
by hand.** Result payloads are widened to structural shapes (the UI reads a subset).

The backend is **kitId + file-tree** based, so every path-shaped argument
(`path`/`rootPath`/`kitPath`) is treated as a **kit id**. Desktop-only seams map to
web behavior:

| Seam | Web behavior |
|---|---|
| `select*` (open pickers) | hidden `<input type=file>` (or no-op for folders) |
| `save*` / `package`/`export` | trigger a **browser download** of returned bytes/text |
| `importAgentKitPackage` | multipart upload of the chosen `File` → `/api/import/zip` |
| `openFolder` | no-op | `openExternalUrl` | `window.open` |
| `getInitialDeepLinks`/`onDeepLink` | URL query params (`?import=…`) + `popstate` |
| `checkForUpdate`/`relaunchApp` | `null` / `location.reload()` (web self-updates) |
| auth `begin/complete/restore/disconnect` | the **AuthKit cookie session** (not device-auth); `/api/account` reports state |

Methods with no web equivalent (`addKitToLibrary`, `inspect*Candidate/Package`,
`renderAgentKitDraft`, `summarizeExampleInputDocuments`, `runAgentKitWithAi`) throw a
clear `NotAvailableOnWebError`.

### UI (`app/forge/`)

**Approach: Option 2 (focused web UI), not importing the desktop `App.tsx`.** The
desktop UI is path-based with deep `@tauri-apps`/Vite coupling; threading
kitId-as-path through ~12k lines safely in one pass was not feasible. Instead the
web UI (`app/forge/ForgeApp.tsx`) is a focused client component over the **same
WebForgeClient seam**, covering the primary flows:

- **My Kits**: owned kits + favorites (Market references).
- **Create** from template (`blank` / `financial-review`).
- **Edit** kit files (tree view + save).
- **Validate** (profile selector), **Package**, **Export** (one-file / Claude Code /
  Codex) — all download in the browser.
- **Import**: upload `.agentkit.zip`, from Git, from Market, favorite a Market kit.
- **Licensed-kit in-memory preview** (online-only, never persisted).

**Deferred:** AI draft generate/revise UI, settings/AI-provider management, Market
**submit** UI, update-check UI (the corresponding `/api/settings*`,
`/api/market/submit`, `/api/kits/update-check` routes are not part of Phase 1 — the
client methods degrade or throw until those land).

### Helm / ArgoCD (not built here)

The self-host k8s path follows the **same pattern as the Market self-host
backend** (see `market-phase2-plan`): Postgres + MinIO/S3 KitStore adapter,
runtime env via a `Secret`, the standalone image above behind an `Ingress`,
deployed via a Helm chart and ArgoCD. The chart is intentionally **not** built
in Phase 1.
