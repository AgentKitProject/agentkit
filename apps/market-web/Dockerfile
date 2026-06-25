# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------- #
# AgentKitMarket web app — workspace-aware self-host image.
#
# BUILD CONTEXT IS THE MONOREPO ROOT, not this package dir. The app depends on
# workspace packages (@agentkitforge/contracts, @agentkitforge/ui) that live in
# sibling dirs, so the whole pnpm workspace must be visible to the build:
#
#     docker build -f apps/market-web/Dockerfile -t agentkitmarket-app .
#
# Nothing about the backend, WorkOS, or profile service is baked at build time;
# all server config is read from `process.env` at request time (Next.js
# standalone runtime), so one image serves hosted and self-hosted (k8s) alike.
#
# @agentkit-commercial/market-web is an optionalDependency that is PRIVATE and
# absent from this public build. pnpm skips unresolved optionalDependencies
# rather than failing, so --frozen-lockfile installs cleanly without it.
# ---------------------------------------------------------------------------- #

ARG NODE_VERSION=22-slim
ARG PNPM_VERSION=11.9.0

# ---------------------------------------------------------------------------- #
# base — pnpm available via corepack.
# ---------------------------------------------------------------------------- #
FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ---------------------------------------------------------------------------- #
# deps — install the full workspace from the lockfile.
#
# Copy the workspace manifest, root manifest+lockfile, and EVERY workspace
# package.json (apps/*, packages/*) before installing, so the dependency graph
# is complete and Docker caches this layer across source changes.
# ---------------------------------------------------------------------------- #
FROM base AS deps
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

# ---------------------------------------------------------------------------- #
# builder — full source, build the app's standalone bundle + its workspace deps.
# BUILD_STANDALONE=1 flips next.config.ts to output:"standalone". The filter
# `agentkitmarket-app...` builds the target plus its workspace dependencies
# first (so @agentkitforge/ui dist exists for transpilePackages and contracts
# dist for the server). Next traces the pnpm workspace and emits the standalone
# tree under .next/standalone/ preserving the apps/<x> + packages/* layout.
# ---------------------------------------------------------------------------- #
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
ENV BUILD_STANDALONE=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter agentkitmarket-app... build

# ---------------------------------------------------------------------------- #
# runtime — minimal standalone server, non-root.
#
# The standalone output is rooted at the workspace root and KEEPS the monorepo
# layout: server.js is at .next/standalone/apps/market-web/server.js, with a
# pruned node_modules + traced packages/* hoisted at the standalone root. Copy
# the whole standalone tree to /app and run apps/market-web/server.js. Static
# assets + public files are not traced and are copied to the paths the server
# expects (relative to the app dir inside the tree).
# ---------------------------------------------------------------------------- #
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/market-web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/market-web/.next/static ./apps/market-web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/market-web/public ./apps/market-web/public

USER nextjs
EXPOSE 3000
CMD ["node", "apps/market-web/server.js"]
