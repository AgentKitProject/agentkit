# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------- #
# AgentKitAuto web app — single, runtime-configured self-host image.
#
# Mirrors agentkitmarket-app / agentkitforge-web: build with BUILD_STANDALONE=1
# to emit `.next/standalone` (gated in next.config.ts so the hosted Amplify
# build is unaffected), then run `node server.js`. NOTHING about WorkOS/OIDC,
# the data backend, AI keys, the Market URL, or the worker dispatch config is
# baked at build time — all of it is read from server-side `process.env` at
# request time, so ONE image serves the hosted deployment and any self-hosted
# Kubernetes cluster. Supply config at runtime via env / k8s ConfigMap + Secret.
#
# ── DEPENDENCY NOTE ──────────────────────────────────────────────────────────
# package.json pulls three SIBLING packages via the `github:` shorthand:
#   @agentkitforge/auto-core    -> github:AgentKitProject/agentkitauto-core
#   @agentkitforge/gateway-core -> github:AgentKitProject/agentkitgateway-core
#   @agentkitforge/ui           -> github:AgentKitProject/agentkitforge-ui
# All three repos are PUBLIC. The committed package-lock.json records them as
# `git+ssh://…` (which is what resolves locally with the developer's SSH key),
# but the build container has no SSH key. `npm ci` will fail to fetch those over
# ssh, so we fall back to `npm install`, which re-resolves the `github:`
# shorthand for public repos via the codeload HTTPS tarball — no git/SSH needed.
# This is the same `npm ci || npm install` pattern proven in agentkitforge-web.
# (No `file:` sibling deps here, so the worker's parent-context checkout pattern
# does NOT apply — a plain repo-root build context is sufficient.)
# ---------------------------------------------------------------------------- #

# ---- Builder stage: produce the standalone server bundle --------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Emit the standalone server bundle (gated in next.config.ts).
ENV BUILD_STANDALONE=1
COPY package.json package-lock.json* ./
# `npm ci` enforces the lockfile but can't fetch the git+ssh github: deps in a
# keyless container; fall back to `npm install` which fetches public github:
# deps over HTTPS. See DEPENDENCY NOTE above.
RUN npm ci || npm install
COPY . .
RUN npm run build

# ---- Runtime stage: minimal standalone server, non-root --------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nextjs

# The standalone output already contains a pruned node_modules and server.js.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
