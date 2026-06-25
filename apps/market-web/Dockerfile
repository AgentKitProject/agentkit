# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------- #
# AgentKitMarket web app — single, runtime-configured image.
#
# Nothing about the backend, WorkOS, or profile service is baked at build time.
# The app reaches its backend and resolves WorkOS/admin/profile config from
# server-side `process.env` at request time (Next.js standalone runtime), so one
# image serves the hosted deployment and any self-hosted Kubernetes cluster.
# Supply config at runtime via env / k8s ConfigMap + Secret.
# ---------------------------------------------------------------------------- #

# ---------------------------------------------------------------------------- #
# Dependencies stage — install all deps (incl. devDeps for the build).
# ---------------------------------------------------------------------------- #
FROM node:22-slim AS deps
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------- #
# Build stage — produce the standalone server bundle.
#
# `next build` does NOT require real NEXT_PUBLIC_* / WORKOS values: all backend
# access is server-side and every route is dynamic, so no runtime config is
# inlined into the client bundle. We do not pass build args; runtime env wins.
# ---------------------------------------------------------------------------- #
FROM node:22-slim AS builder
WORKDIR /build
ENV NEXT_TELEMETRY_DISABLED=1
# Emit the standalone server bundle (gated in next.config.ts so Amplify's build
# is unaffected).
ENV BUILD_STANDALONE=1
COPY --from=deps /build/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------- #
# Runtime stage — minimal standalone server, non-root.
# ---------------------------------------------------------------------------- #
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nextjs

# Standalone server + static assets + public files.
# The standalone output already contains a pruned node_modules and server.js.
COPY --from=builder --chown=nextjs:nodejs /build/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /build/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /build/public ./public

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
