# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------- #
# AgentKitMarket core — workspace-aware self-host image (API + worker).
#
# BUILD CONTEXT IS THE MONOREPO ROOT (the package depends on the workspace
# sibling @agentkitforge/contracts):
#
#     docker build -f packages/market-core/Dockerfile -t agentkitmarket-core .
#
# ONE image serves BOTH the HTTP API and the SQS-style worker; they share the
# compiled bundle and differ only in entrypoint:
#   - API server (default):  node dist/entrypoints/server.js
#   - Worker (override CMD):  node dist/entrypoints/worker.js
# (mirrors the old per-repo image's api-vs-worker split.)
#
# The build copies dist/adapters/selfhost/schema.sql, which the self-host
# Postgres adapter reads at runtime to provision the schema.
#
# @agentkit-commercial/market-core is a PRIVATE optionalDependency, absent here;
# pnpm skips unresolved optionalDependencies (no install failure).
# ---------------------------------------------------------------------------- #

ARG NODE_VERSION=22-slim
ARG PNPM_VERSION=11.9.0

FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ---------------------------------------------------------------------------- #
# builder — install the full workspace, build market-core (+ its workspace deps),
# then `pnpm deploy` a self-contained production tree (dist + pruned prod
# node_modules with workspace deps inlined, no symlinks) into /out.
# `pnpm deploy` runs the package's `prepare` (= build), so dist + schema.sql are
# produced inside /out. --legacy makes deploy work for a workspace-member target.
# ---------------------------------------------------------------------------- #
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
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @agentkitforge/market-core deploy --prod --legacy /out

# ---------------------------------------------------------------------------- #
# runtime — dist + production node_modules only, non-root.
# ---------------------------------------------------------------------------- #
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup --system --gid 1001 appgroup \
 && adduser  --system --uid 1001 --ingroup appgroup appuser

COPY --from=builder --chown=appuser:appgroup /out/dist ./dist
COPY --from=builder --chown=appuser:appgroup /out/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /out/package.json ./package.json

USER appuser

# API server by default. To run the worker instead, override the command:
#   docker run <image> node dist/entrypoints/worker.js
EXPOSE 8080
CMD ["node", "dist/entrypoints/server.js"]
