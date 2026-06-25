# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------- #
# AgentKitAuto worker image — workspace-aware.
#
# BUILD CONTEXT IS THE MONOREPO ROOT. auto-core depends on the workspace sibling
# @agentkitforge/gateway-core (now a `workspace:*` dep, no longer a `file:` /
# `github:` link), plus @agentkitforge/contracts:
#
#     docker build -f packages/auto-core/Dockerfile -t agentkitauto-worker .
#
# `pnpm deploy` produces a self-contained production tree (dist + pruned prod
# node_modules with gateway-core/contracts inlined and their dist built) — no
# sibling-checkout dance is needed anymore. dist/adapters/selfhost/schema.sql is
# included for the self-host Postgres adapter (read at runtime).
#
# Do NOT bake any secrets — runtime config (RUN_ID, AUTO_* tables, resolve URL +
# service key, ANTHROPIC_API_KEY, AWS creds) is injected by ECS/k8s at launch.
# AWS access uses the task ROLE (default credential chain), never static keys.
# ---------------------------------------------------------------------------- #

ARG NODE_VERSION=22-slim
ARG PNPM_VERSION=11.9.0

FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

FROM base AS builder
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/market-web/package.json        apps/market-web/package.json
COPY apps/forge-web/package.json         apps/forge-web/package.json
COPY apps/auto-web/package.json          apps/auto-web/package.json
COPY apps/profile-web/package.json       apps/profile-web/package.json
COPY packages/contracts/package.json     packages/contracts/package.json
COPY packages/ui/package.json            packages/ui/package.json
COPY packages/core/package.json          packages/core/package.json
COPY packages/market-core/package.json   packages/market-core/package.json
COPY packages/auto-core/package.json     packages/auto-core/package.json
COPY packages/gateway-core/package.json  packages/gateway-core/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild
COPY . .
RUN pnpm --filter "@agentkitforge/auto-core..." build \
 && pnpm --filter @agentkitforge/auto-core deploy --prod --legacy --ignore-scripts /out

# ---------------------------------------------------------------------------- #
# runtime — dist + production node_modules; root PID 1 (entrypoint drops to node)
#
# Phase D (hardened isolation): install `gosu`, a tiny privilege-drop tool. The
# hosted Fargate task runs with a READ-ONLY root filesystem; the only writable
# path is a scratch volume mounted at /scratch, ROOT-owned by Fargate. The
# worker runs as non-root `node`, so the container starts as root, the
# entrypoint chowns the scratch mount, then EXECs the worker AS node via gosu.
# ---------------------------------------------------------------------------- #
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends gosu; \
    rm -rf /var/lib/apt/lists/*; \
    gosu nobody true

COPY --from=builder /out/dist ./dist
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/package.json ./package.json

# Entrypoint that makes the root-owned scratch mount writable by `node`, then
# drops privileges to `node` for the worker. Lives in the package source dir.
COPY packages/auto-core/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# IMPORTANT: the container starts as ROOT (no `USER node`) so the entrypoint can
# chown the Fargate-mounted scratch volume, then EXECs the worker via
# `gosu node`, so the LONG-LIVED worker process is NON-ROOT. Do NOT add a `USER`
# line above — that would start PID 1 as node and break the scratch chown.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# The compiled run-to-completion task main (exec'd as node by the entrypoint).
CMD ["node", "dist/entrypoints/run-task.js"]
