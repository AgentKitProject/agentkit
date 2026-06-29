# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------- #
# AgentKitProject apex site (apps/site) — self-contained static nginx image.
#
# BUILD CONTEXT IS THE MONOREPO ROOT, not this package dir. The Astro site
# depends on a workspace package (@agentkitforge/ui = workspace:*) that lives in
# a sibling dir, so the whole pnpm workspace must be visible to the build:
#
#     docker build -f apps/site/Dockerfile -t agentkitproject-site .
#
# Unlike the legacy forge-site chart (an nginx PROXY to a Spaces CDN), this image
# BAKES the built static site (apps/site/dist) directly into nginx — there is no
# upstream/origin and no runtime config. One image is fully self-contained and
# serves apex + www + docs (host-based redirects handled in nginx.conf; TLS is
# terminated at the DOKS ingress, which forwards over HTTP preserving Host).
# ---------------------------------------------------------------------------- #

ARG NODE_VERSION=24.18.0-slim
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
COPY apps/site/package.json              apps/site/package.json
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

# ---------------------------------------------------------------------------- #
# builder — full source; build @agentkitforge/ui first, then the Astro site.
# The `@agentkitproject/site...` filter builds the target plus its workspace
# dependencies (so @agentkitforge/ui dist exists before `astro build`). Astro
# emits the fully static site into apps/site/dist.
# ---------------------------------------------------------------------------- #
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter @agentkitproject/site... build

# ---------------------------------------------------------------------------- #
# runtime — tiny nginx serving the baked static site. No app code, no env.
# ---------------------------------------------------------------------------- #
FROM nginx:1.27-alpine AS runtime
COPY apps/site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/site/dist /usr/share/nginx/html
EXPOSE 80
