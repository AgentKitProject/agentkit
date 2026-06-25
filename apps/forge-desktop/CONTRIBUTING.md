# Contributing to AgentKitForge

AgentKitForge welcomes public contributions to the desktop app. This repository is the public contribution target for the Tauri + React app.

The website/deployment infrastructure and Agent Kit Market backend are not public contribution targets.

## Local Setup

Prerequisites:

- Node.js 26.
- npm.
- Rust stable and Cargo.
- Tauri v2 prerequisites for your OS.
- Windows release builds require the Tauri Windows bundling toolchain used by `npm run build:tauri`.

Install dependencies:

```powershell
npm ci
```

Run the local app:

```powershell
npm run dev
```

## Checks

Before opening a pull request, run:

```powershell
npm run check
npm run smoke
npm run build:tauri
```

`npm run smoke` runs the lightweight TypeScript/Rust check plus the frontend build. Use `npm run build:tauri` when your change may affect desktop packaging, Tauri commands, Rust code, bundled resources, app metadata, or release behavior.

## Contribution Scope

Good contribution areas include:

- Desktop app UX.
- AI providers.
- Local agent adapters.
- Import/export workflows.
- Guided Builder.
- Use mode.
- Tests.
- Documentation.

Please open an issue or discussion before starting work on:

- Tauri permission or capability changes.
- Credential/API key handling.
- Major UI redesigns.
- Provider authentication changes.
- Installer or release changes.
- Security-sensitive import logic.

## Pull Requests

Keep pull requests focused and explain the user-facing behavior change. Include screenshots for UI changes, describe security implications where relevant, and update docs when workflows change.

## Conventional Commits and Releases

Use Conventional Commits for commit titles so Release Please can create release PRs, tags, GitHub Releases, and release notes.

Common examples:

- `feat: add a new provider option`
- `fix: correct prepared prompt validation`
- `fix(security): redact provider token errors`
- `docs: update import instructions`
- `chore: update CI configuration`

Version impact:

- `feat:` creates a minor release.
- `fix:` and `fix(security):` create a patch release.
- Breaking changes before `1.0.0` are treated as minor releases, but they must be documented clearly.

Release PRs are generated automatically by Release Please from commits on `main`. The release happens when the Release Please PR is merged. Installer artifacts are built separately by a release-artifacts workflow/process.

Use a breaking-change footer when needed:

```text
BREAKING CHANGE: describe the migration or behavior change.
```
