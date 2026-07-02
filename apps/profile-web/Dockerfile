# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------- #
# AgentKitProfile web app — workspace-aware self-host image.
#
# BUILD CONTEXT IS THE MONOREPO ROOT (workspace deps live in sibling dirs):
#
#     docker build -f apps/profile-web/Dockerfile -t agentkitprofile-app .
#
# Nothing about the database, WorkOS, or service keys is baked at build time;
# the app resolves DATABASE_URL and WorkOS/service config from `process.env` at
# request time (Next.js standalone runtime). One image serves hosted + k8s.
#
# The image also carries the migration script + SQL so a k8s Job can run
# `node --experimental-strip-types apps/profile-web/scripts/migrate.mts`
# against the same image. The `pg` driver it imports is kept external
# (serverExternalPackages) so it is traced into the standalone node_modules.
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
COPY apps/forge/package.json         apps/forge/package.json
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
RUN pnpm --filter agentkitprofile-app... build

# ---------------------------------------------------------------------------- #
# runtime — standalone server (workspace layout preserved), non-root.
# server.js lives at .next/standalone/apps/profile-web/server.js.
# ---------------------------------------------------------------------------- #
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/profile-web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/profile-web/.next/static ./apps/profile-web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/profile-web/public ./apps/profile-web/public

# Migration assets — not part of the Next standalone trace. Copied so the
# self-host migration Job can run `node --experimental-strip-types
# apps/profile-web/scripts/migrate.mts` from this same image. The script reads
# db/migrations/*.sql relative to scripts/, so both dirs are required.
COPY --from=builder --chown=nextjs:nodejs /app/apps/profile-web/scripts ./apps/profile-web/scripts
COPY --from=builder --chown=nextjs:nodejs /app/apps/profile-web/db ./apps/profile-web/db

USER nextjs
EXPOSE 3000
CMD ["node", "apps/profile-web/server.js"]
