# Orphaned desktop-Forge workflows

GitHub Actions only runs workflows located at the **repo root** `.github/workflows/`.
Workflows in this directory (`apps/forge-desktop/.github/workflows/`) **do not run** —
they were inherited from the standalone `agentkitforge-app` repo.

## Activated (moved to root, remapped for the monorepo)

These were moved to the repo root and remapped to run from `apps/forge-desktop`:

- `release-artifacts.yml` → `.github/workflows/forge-desktop-release-artifacts.yml`
- `security.yml` → `.github/workflows/forge-desktop-security.yml` (path-scoped to `apps/forge-desktop/**`)
- `smoke.yml` → `.github/workflows/forge-desktop-smoke.yml` (path-scoped to `apps/forge-desktop/**`)

## Still orphaned — release-please.yml (SEPARATE TASK, do NOT hack)

`release-please.yml` is intentionally **left here, not activated**. Activating it
cleanly requires monorepo-wide release-please configuration that does not yet exist:

- Its `release-please-config.json` / `.release-please-manifest.json` live in
  `apps/forge-desktop/` with the package path `"."` (config-relative). The
  release-please-action defaults to reading `config-file`/`manifest-file` from the
  **repo root**, so it needs either a root manifest config keyed on the
  `apps/forge-desktop` component, or `config-file`/`manifest-file` inputs pointed
  at `apps/forge-desktop/...` plus reconciled component paths.
- `extra-files` references `src-tauri/tauri.conf.json` → would need
  `apps/forge-desktop/src-tauri/tauri.conf.json`.
- It also embeds a `build-release-artifacts` job that duplicates
  `forge-desktop-release-artifacts.yml`; that overlap must be reconciled.
- There is currently **no** root-level release-please setup in this monorepo to
  coordinate with.

Treat desktop release-please activation as its own task that decides the monorepo
release-please strategy (single root manifest vs. per-app), then wires the desktop
component into it.

## Not a workflow

- `SECURITY_CI_POLICY.md` is documentation referenced by the security workflow;
  left in place.
