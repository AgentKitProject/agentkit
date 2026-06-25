# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------- #
# AgentKitAuto web app — workspace-aware self-host image.
#
# BUILD CONTEXT IS THE MONOREPO ROOT (workspace deps live in sibling dirs):
#
#     docker build -f apps/auto-web/Dockerfile -t agentkitauto-app .
#
# The sibling deps (@agentkitforge/auto-core, /gateway-core, /core, /ui,
# /contracts) are now WORKSPACE packages resolved from the lockfile — no git or
# SSH access is needed (the old per-repo `github:` shorthand is gone). All
# WorkOS/OIDC, data-backend, AI-key, Market-URL, and worker-dispatch config is
# read from `process.env` at request time; nothing is baked at build time.
#
# @agentkit-commercial/gateway is a PRIVATE optionalDependency, absent here;
# pnpm skips unresolved optionalDependencies (no install failure).
# ---------------------------------------------------------------------------- #

ARG NODE_VERSION=22-slim
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
RUN pnpm --filter agentkitauto-app... build

# ---------------------------------------------------------------------------- #
# runtime — standalone server (workspace layout preserved), non-root.
# server.js lives at .next/standalone/apps/auto-web/server.js.
# ---------------------------------------------------------------------------- #
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/auto-web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/auto-web/.next/static ./apps/auto-web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/auto-web/public ./apps/auto-web/public

USER nextjs
EXPOSE 3000
CMD ["node", "apps/auto-web/server.js"]
