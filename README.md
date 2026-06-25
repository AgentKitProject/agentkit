# agentkit

The open-source AgentKitProject monorepo: apps, shared libraries, charts, and reusable IaC.

- `packages/*` — shared libraries (`@agentkitforge/contracts`, `@agentkitforge/core` + the `agentkitforge` CLI, `@agentkitforge/ui`, market-core, auto-core, gateway-core).
- `apps/*` — Forge (web + desktop), Market, Auto, Profile, site.
- `deploy/*` — Helm charts + reusable Terraform/OpenTofu modules.

Tooling: pnpm workspaces + Turborepo. Internal deps use `workspace:*`; only the CLI
(`@agentkitforge/core`) and (optionally) `@agentkitforge/contracts` publish to npm.

The commercial cost-model (managed billing) lives in a separate **private** repo and is
loaded optionally; without it the stack runs the free/BYO self-host path.
