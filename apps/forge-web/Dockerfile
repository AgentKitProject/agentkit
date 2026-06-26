# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------- #
# AgentKitForge web app — workspace-aware self-host image.
#
# BUILD CONTEXT IS THE MONOREPO ROOT (workspace deps live in sibling dirs):
#
#     docker build -f apps/forge-web/Dockerfile -t agentkitforge-web .
#
# All runtime config (WorkOS, data dir, AI keys, Market URL) is supplied as env
# at deploy time — nothing is baked into the image. `git` is included in the
# runtime stage because /api/import/git shells out to it server-side.
#
# @agentkit-commercial/gateway is a PRIVATE optionalDependency, absent from this
# public build; pnpm skips unresolved optionalDependencies (no install failure).
# ---------------------------------------------------------------------------- #

ARG NODE_VERSION=24.18.0-slim
ARG PNPM_VERSION=11.9.0

FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

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
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild

FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
ENV BUILD_STANDALONE=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter agentkitforge-web... build

# ---------------------------------------------------------------------------- #
# runtime — standalone server (workspace layout preserved), non-root, with git.
# server.js lives at .next/standalone/apps/forge-web/server.js.
# ---------------------------------------------------------------------------- #
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# git: /api/import/git shells out to it. ca-certificates for HTTPS git remotes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/forge-web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/forge-web/.next/static ./apps/forge-web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/forge-web/public ./apps/forge-web/public

# Persist kit data across restarts by mounting a volume here.
ENV AGENTKITFORGE_WEB_DATA_DIR=/data
RUN mkdir -p /data && chown nextjs:nodejs /data
VOLUME ["/data"]

USER nextjs
EXPOSE 3000
CMD ["node", "apps/forge-web/server.js"]
