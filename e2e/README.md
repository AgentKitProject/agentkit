# agentkit-e2e

Standalone Playwright E2E suite for the **deployed** AgentKitProject apps —
hosted prod by default, the gamma self-host staging env via env overrides.
Deliberately kept **outside the pnpm workspace** (`pnpm-workspace.yaml` globs
only `apps/*` + `packages/*`) so it never touches the monorepo install/build
graph — it installs its own `@playwright/test`.

## Projects

| Project | What | Where it runs |
|---|---|---|
| `smoke` | Unauthenticated critical paths (shells, catalog, sign-in enforcement, OIDC discovery). Env-aware: `E2E_ENV=gamma` expects the private catalog. | Both gates + on demand |
| `authed` | Read-only authed checks (apps admit the signed-in user, orgs resolve, kit selector). | Both gates |
| `cuj` | The FULL critical-user-journey suite (`tests/cuj/*.spec.ts`) **including writes** — market submit→cancel, forge kit create/import/package/delete, auto schedules/webhooks/run-dispatch, profile display-name/handle/org lifecycle. Serial, 1 worker. | **Gamma promotion gate** |
| `prod-cuj` | The `@reversible`-tagged subset of `cuj`: reversible writes with cleanup, **no purchases, no LLM spend, no admin surfaces**. | **Prod gate** (deploy-verify-rollback) |
| `canary` | The `@canary`-tagged light health subset. Runs ANONYMOUS by default (authed.spec opts into auth at file level). | The 30-min canary cron |

## Auth

Real **Keycloak form login** for the dedicated E2E user
(`engineering-agentkit@agentkitproject.com`, seeded in both realms). Supply
`E2E_USER` + `E2E_PASSWORD` (CI secrets in agentkit-hosting: `E2E_USER`,
`E2E_PASSWORD_PROD`, `E2E_PASSWORD_GAMMA`); `global-setup.ts` signs into all
four apps once (form → silent SSO) and saves a shared storageState. Without
credentials, authed/cuj specs self-skip.

Env grants: the gamma user is a Keycloak `admins` member **and** on the market
+ profile admin email allowlists (enables admin/org CUJs there); the prod user
is a regular user on purpose.

## Conventions

- Every artifact a test creates is named with the `RUN_ID` prefix (`e2e-…`) and
  cleaned up in-test or in a failure-tolerant `afterAll`. Anything named
  `e2e-*` in any env is disposable test data.
- `@reversible` (in the test title) = safe for prod. Untagged CUJs are
  gamma-only; money-touching paths (Stripe, real LLM runs) are **never** tested.
- LLM journeys are **dispatch-only**: they assert the run record + graceful
  failure surfacing (gamma has a placeholder Anthropic key), never completion.
- `fixtures/e2e-fixture-kit.agentkit.zip` is a publishable-valid kit for
  submit/import journeys (regenerate with the `agentkitforge` CLI:
  `init --template blank` + LICENSE/README + `package`).

## Run locally

```bash
cd e2e && npm install && npm run install:browsers

# prod (read-only unless you pass creds)
npm run test:smoke
E2E_USER=… E2E_PASSWORD=… npm run test:canary

# gamma (tailnet required)
export E2E_ENV=gamma \
  E2E_PROFILE_URL=https://profile.<tailnet>.ts.net \
  E2E_MARKET_URL=https://market.<tailnet>.ts.net \
  E2E_FORGE_URL=https://forge.<tailnet>.ts.net \
  E2E_AUTO_URL=https://auto.<tailnet>.ts.net \
  E2E_AUTH_URL=https://auth.<tailnet>.ts.net
E2E_USER=… E2E_PASSWORD=… npm run test:gate:gamma
```

## Where this runs in CI (the delivery pipeline)

1. **agentkit main push** → `promote-notify.yml` dispatches
   `agentkit-hosting/promote.yml` with the sha.
2. **Gamma gate**: promote repins gamma gitops to the sha's rebuilt images,
   waits for ArgoCD Synced/Healthy, runs `smoke+authed+cuj` over the tailnet;
   failure ⇒ the repin is reverted (gamma rolls back).
3. **Prod gate**: on gamma green, promote (re)builds the commercial market web
   image if needed, repins prod values; the hosting repo's
   `deploy-verify-rollback.yml` then runs `smoke+authed+prod-cuj` and
   auto-reverts on failure.
4. **Canary**: `canary.yml` runs the `canary` project vs both envs every 30
   minutes; a red env blocks promotion (bake semantics) and opens an alert
   issue.
