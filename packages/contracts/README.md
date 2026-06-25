# @agentkitforge/contracts

Shared cross-service contracts for the AgentKitProject ecosystem.

Every payload, route, status enum, and service URL that crosses a repo boundary
is defined **here first**, then consumed by both sides of the seam:

| Seam | Provider | Consumers |
|---|---|---|
| Profile API (`/profiles/*`, `/me`) | agentkitprofile-infra | agentkitprofile-app, agentkitmarket-app, future Auto |
| Forge ↔ Market (`/api/forge/*`) | agentkitmarket-app | agentkitforge-app |
| Market backend (`/admin/*`, `/users/*`, `/kits*`) | agentkitmarket-infra | agentkitmarket-app |

## Contents

- `src/profile.ts` — public profile + publisher snapshot schemas, Profile API route builders, trusted headers
- `src/market.ts` — submission/validation/review status enums, Forge submission payloads, Forge↔Market and Market-backend route builders
- `environments.json` — canonical service base URLs per environment (the service manifest)
- `fixtures/` — JSON fixtures for non-TypeScript consumers (Forge's Rust tests) and provider contract tests

## Rules

1. New cross-repo fields/routes are added here **before** either side implements them.
2. Providers and consumers both add a contract test against this package.
3. Changing a published contract is a breaking change: bump the version and deploy both sides together.

TypeScript consumers install the published public npm package:

```json
"@agentkitforge/contracts": "^0.2.0"
```

Rust consumers (and any non-TS consumer) assert request/response shapes against `fixtures/*.json`.
