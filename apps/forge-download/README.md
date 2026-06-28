# @agentkitproject/forge-download

Astro + TypeScript static **desktop-Forge download site** — public pages, docs,
download buttons, release links, and the Tauri updater manifest. Served at
`https://forge.agentkitproject.com/` from a **DigitalOcean Spaces bucket + CDN**
(`agentkit-forge-releases`). Consolidated here from `agentkitforge-infra` during
the M4 AWS→DO migration.

## Commands (pnpm workspace)

```bash
pnpm --filter @agentkitproject/forge-download dev
pnpm --filter @agentkitproject/forge-download... build   # builds workspace deps too
```

Builds to `dist/`. `astro.config.mjs` is `output: 'static'`,
`trailingSlash: 'always'`, `site: 'https://forge.agentkitproject.com'`. Release
download links are **host-relative** (`/releases/v<version>/...`), so they work
regardless of which domain serves the bucket.

## Layout

- `src/` — pages, layouts, components (uses `@agentkitforge/ui` via `workspace:*`).
- `src/data/releases.json` — download-page release metadata (updated by the mirror pipeline).
- `public/updates/latest.json` — Tauri updater manifest (short-cached; updated by the mirror pipeline).
- `scripts/` — release mirror helpers (`generate-tauri-updater-manifest.mjs`,
  `update-release-metadata.mjs`) + `deploy-spaces.sh` (Spaces upload + CDN flush).

## CI

- `.github/workflows/forge-download-deploy.yml` — builds + deploys the site to
  Spaces on push to `apps/forge-download/**`.
- `.github/workflows/forge-release-mirror.yml` — on a new agentkitforge-app
  release, mirrors artifacts (byte-identical) to `s3://agentkit-forge-releases/releases/v<version>/`,
  regenerates the updater manifest pointing at `forge.agentkitproject.com`, and
  flushes the CDN for `/updates/latest.json`.

> Auto-update safety: the updater poll URL
> `https://forge.agentkitproject.com/updates/latest.json` is hard-coded in
> shipped binaries — never change the domain or path. Artifacts must stay
> byte-identical so minisign `.sig` signatures keep verifying.
