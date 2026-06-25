# Self-host image for agentkitforge-web. Mirrors the agentkitmarket-app pattern:
# build with BUILD_STANDALONE=1 to emit .next/standalone, then run `node server.js`.
# All runtime config (WorkOS, data dir, AI keys, Market URL) is supplied as env
# at deploy time — nothing is baked into the image.
#
# `git` is included because /api/import/git shells out to it server-side.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV BUILD_STANDALONE=1
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Persist kit data across restarts by mounting a volume here.
ENV AGENTKITFORGE_WEB_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
