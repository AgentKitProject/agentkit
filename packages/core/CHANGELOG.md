# Changelog

All notable changes to AgentKitForge Core will be documented in this file.

This project follows Semantic Versioning. Before `1.0.0`, minor versions may include breaking changes.

## Unreleased

- Added open-source governance, security, contribution, versioning, release, spec, and CLI documentation.
- **market:** `normalizeMarketBaseUrl` now honors an operator-configured Market base URL (any valid http/https URL) instead of locking to `market.agentkitproject.com`, so the tokenless kit update-check works against self-hosted Markets.

## [0.6.1](https://github.com/AgentKitProject/agentkitforge-core/compare/v0.6.0...v0.6.1) (2026-06-24)


### Bug Fixes

* **market:** honor operator-configured Market base URL (self-host update-check) ([#10](https://github.com/AgentKitProject/agentkitforge-core/issues/10)) ([c007c87](https://github.com/AgentKitProject/agentkitforge-core/commit/c007c875fb0e76141a3b15a57630cacaa2608843))

## [0.6.0](https://github.com/AgentKitProject/agentkitforge-core/compare/v0.5.0...v0.6.0) (2026-06-19)


### Features

* **gateway:** add hosted gateway client with tool-use loop driver ([6c4c4a8](https://github.com/AgentKitProject/agentkitforge-core/commit/6c4c4a82fbab6c937a9f248aa4bbbc320d6959cc))

## [0.5.0](https://github.com/AgentKitProject/agentkitforge-core/compare/v0.4.0...v0.5.0) (2026-06-16)


### Features

* **market:** add cloud favorites client (list/add/remove) ([8429f5d](https://github.com/AgentKitProject/agentkitforge-core/commit/8429f5dc986259839d59a27f66bdac777581f73e))

## [0.4.0](https://github.com/AgentKitProject/agentkitforge-core/compare/v0.3.0...v0.4.0) (2026-06-16)


### Features

* **market:** online-only paid/licensed kit client (fetchLicensedKit, entitlements) ([3ecf865](https://github.com/AgentKitProject/agentkitforge-core/commit/3ecf865747c1e01c2d9ef3e0270a2476b2155373))

## [0.3.0](https://github.com/AgentKitProject/agentkitforge-core/compare/v0.2.0...v0.3.0) (2026-06-14)


### Features

* add read/update Agent Kit manifest version API and CLI ([4aca592](https://github.com/AgentKitProject/agentkitforge-core/commit/4aca592d49d8bdbf5308b2ac48e5bc7ac0cea3c3))
* **cli:** add market login/logout/submit/import commands + cross-platform store tests ([242d404](https://github.com/AgentKitProject/agentkitforge-core/commit/242d404f0d497d3acbc2d9ba02a340ee480ff166))
* **market:** add core auth foundation (token store + WorkOS device-auth) ([5f92904](https://github.com/AgentKitProject/agentkitforge-core/commit/5f92904bea5068ed87bcf92a03147b8aab454032))
* **market:** add read-only update-check capability (Bridge 5 core half) ([116823b](https://github.com/AgentKitProject/agentkitforge-core/commit/116823b97d3dcea61f6d1ea74a9af8f9b8fbc901))
* **market:** consume @agentkitforge/contracts; fix update-check route ([283d401](https://github.com/AgentKitProject/agentkitforge-core/commit/283d4013238c002cdcf0993ab15480d581a01cb6))
* switch kit content version from semver to sequential vN integer ([b286520](https://github.com/AgentKitProject/agentkitforge-core/commit/b2865200f90b024cac09f58e215753373b432c0f))

## [0.2.0](https://github.com/AgentKitProject/agentkitforge-core/compare/v0.1.1...v0.2.0) (2026-05-31)


### Features

* harden core cross-platform path handling ([a48650e](https://github.com/AgentKitProject/agentkitforge-core/commit/a48650ec907b954e7f07cab296e33fb9855bd508))

## [0.1.1](https://github.com/AgentKitProject/agentkitforge-core/compare/v0.1.0...v0.1.1) (2026-05-29)


### Bug Fixes

* make core installable from source package installs ([cd63497](https://github.com/AgentKitProject/agentkitforge-core/commit/cd63497006194ef05b626e64b65f8ea24862eee2))

## 1.0.0 (2026-05-29)


### Features

* prepare initial public preview ([61e8d7d](https://github.com/AgentKitProject/agentkitforge-core/commit/61e8d7d9c9a1efac31c6dc62b4ed9c42d97bf729))


### Bug Fixes

* set initial release baseline ([29fc113](https://github.com/AgentKitProject/agentkitforge-core/commit/29fc11376ce64175dfb9564b5fa625dc24eb63d2))

## v0.1.0 Public Preview

- Initial public preview target.
- Core Agent Kit manifest validation.
- Validation profiles: `local-valid`, `publishable`, `trusted`, and `verified`.
- Agent Kit scaffolding templates.
- Draft rendering and draft request helpers.
- Prepared Prompt schema, validation, and rendering.
- Context Builder.
- One-file Markdown export.
- `.agentkit.zip` packaging.
- Codex and Claude Code target exports.
- CLI workflows for validation, packaging, export, prompt rendering, context building, and inspection.
