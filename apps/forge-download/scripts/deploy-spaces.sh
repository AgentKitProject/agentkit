#!/usr/bin/env bash
# Deploy the built forge-download static site to the DigitalOcean Spaces bucket.
#
# Replaces the legacy AWS deploy-site.sh (S3 + CloudFront) for the M4 AWS->DO
# migration. Uploads `dist/` to the Spaces bucket via the S3-compatible API,
# NEVER touching /releases/* (those are managed by the release-mirror workflow
# and must stay byte-identical for updater signature verification).
#
# Caching:
#   * /updates/latest.json    -> Cache-Control: max-age=60  (SHORT — updater poll)
#   * /_astro/*               -> immutable, 1y
#   * everything else (HTML)  -> max-age=300
#
# DO CDN has no per-path TTL, so these per-object Cache-Control headers are what
# enforce the short TTL on latest.json. A CDN flush of /updates/latest.json
# after upload makes the new manifest visible immediately.
#
# Env:
#   SPACES_BUCKET            (default: agentkit-forge-releases)
#   SPACES_ENDPOINT          (default: https://nyc3.digitaloceanspaces.com)
#   AWS_ACCESS_KEY_ID        -> Spaces access key
#   AWS_SECRET_ACCESS_KEY    -> Spaces secret key
#   CDN_ID                   (optional) DO CDN id; if set + doctl present, flush latest.json
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUCKET="${SPACES_BUCKET:-agentkit-forge-releases}"
ENDPOINT="${SPACES_ENDPOINT:-https://nyc3.digitaloceanspaces.com}"
DIST="$ROOT_DIR/dist"

if [[ ! -d "$DIST" ]]; then
  echo "::error::dist/ not found. Build the site first (pnpm --filter @agentkitproject/forge-download build)."
  exit 1
fi

S3="aws s3"
ENDPOINT_ARG=(--endpoint-url "$ENDPOINT")

# Sync the whole site EXCEPT release artifacts. --delete prunes stale site files
# but the excludes keep /releases/* (and never-built /updates) untouched.
$S3 sync "$DIST/" "s3://$BUCKET/" \
  "${ENDPOINT_ARG[@]}" \
  --acl public-read \
  --delete \
  --exclude "releases/*" \
  --exclude "updates/latest.json" \
  --cache-control "public,max-age=300"

# Long-cache immutable hashed assets.
if [[ -d "$DIST/_astro" ]]; then
  $S3 cp "$DIST/_astro/" "s3://$BUCKET/_astro/" \
    "${ENDPOINT_ARG[@]}" \
    --recursive \
    --acl public-read \
    --cache-control "public,max-age=31536000,immutable"
fi

# Short-cache the updater manifest so polling clients see new releases quickly.
if [[ -f "$DIST/updates/latest.json" ]]; then
  $S3 cp "$DIST/updates/latest.json" "s3://$BUCKET/updates/latest.json" \
    "${ENDPOINT_ARG[@]}" \
    --acl public-read \
    --content-type "application/json" \
    --cache-control "max-age=60"
fi

# Flush the CDN edge for latest.json so the short TTL isn't shadowed by the
# global CDN ttl. Requires doctl auth (DIGITALOCEAN_ACCESS_TOKEN) + CDN_ID.
if [[ -n "${CDN_ID:-}" ]] && command -v doctl >/dev/null 2>&1; then
  doctl compute cdn flush "$CDN_ID" --files /updates/latest.json
else
  echo "CDN_ID unset or doctl missing; skipping CDN flush of /updates/latest.json."
fi
