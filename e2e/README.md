# agentkit-e2e

Standalone Playwright E2E smoke suite for the **deployed** hosted AgentKitProject
apps. Deliberately kept **outside the pnpm workspace** (`pnpm-workspace.yaml`
globs only `apps/*` + `packages/*`) so it never touches the monorepo install/build
graph — it installs its own `@playwright/test`.

## What it checks

- `tests/smoke.spec.ts` (project **smoke**, no auth) — the post-deploy gate:
  - Profile / Market / Forge home pages load with their branded titles.
  - Market catalog renders (`/` + `/kits`).
  - Auto and Web-Forge bounce anonymous users to `/auth/sign-in` (auth enforced).
  - Auto sign-in page renders (WorkOS AuthKit up, not 5xx).
- `tests/authed.spec.ts` (project **authed**) — runs only when a dedicated test
  user's session is supplied; verifies authed apps don't bounce and P4 orgs
  resolve from Profile. Self-skips otherwise.

## Run locally (against hosted prod by default)

```bash
cd e2e
pnpm install            # or npm install
pnpm install:browsers
pnpm test:smoke
```

Point at another environment by overriding any of:
`E2E_PROFILE_URL`, `E2E_MARKET_URL`, `E2E_FORGE_URL`, `E2E_WEBFORGE_URL`,
`E2E_AUTO_URL` (e.g. a staging/canary or a self-host tailnet).

## Authenticated tests (no password in CI)

Capture a dedicated test user's session once, locally:

```bash
# sign in as the test user in the opened browser, then close it
npx playwright open --save-storage=auth/state.json https://auto.agentkitproject.com
```

Store the **contents** of `auth/state.json` as the CI secret
`E2E_STORAGE_STATE_JSON`. The suite materializes it at runtime; the authed
project reuses the cookies. `auth/` is git-ignored. Refresh when the session
expires. CI never sees or types a password.

## CI

Runs via the reusable workflow `.github/workflows/e2e.yml` (callable / manual),
and as the verification gate in the hosting repo's deploy-verify-rollback
pipeline (post-sync → smoke → auto-revert the image repin on failure).
