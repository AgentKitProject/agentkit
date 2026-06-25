# AgentKitForge Release Notes

## [0.6.2](https://github.com/AgentKitProject/agentkitforge-app/compare/v0.6.1...v0.6.2) (2026-06-14)


### Bug Fixes

* convert SecureStorageError to String in non-macOS session store ([d5149c7](https://github.com/AgentKitProject/agentkitforge-app/commit/d5149c72dcf2181ea2d48f1b705379f2a3f4528d))
* spawn tauri via shell on Windows (Node 24 .cmd restriction) ([eb6a9b4](https://github.com/AgentKitProject/agentkitforge-app/commit/eb6a9b4df9234846a3e496bae69eabcd0bcab991))

## [0.6.1](https://github.com/AgentKitProject/agentkitforge-app/compare/v0.6.0...v0.6.1) (2026-06-14)


### Bug Fixes

* gate security-framework to macOS targets ([36fe340](https://github.com/AgentKitProject/agentkitforge-app/commit/36fe3401cbdd0de09fd2cbb498ad84c5ed9a6cbe))

## [0.6.0](https://github.com/AgentKitProject/agentkitforge-app/compare/v0.5.0...v0.6.0) (2026-06-14)


### Features

* add optional AgentKitProject integrations foundation ([83141d4](https://github.com/AgentKitProject/agentkitforge-app/commit/83141d4c7a6c3943d3b4ead767d0b926b0c613bf))
* harden local agent kit import ([7c656b6](https://github.com/AgentKitProject/agentkitforge-app/commit/7c656b6af10263e212d363cf8c77fb67a1781e8c))
* Refactor Forge Market/Auto integration foundation around configurable external service connections ([dedfa18](https://github.com/AgentKitProject/agentkitforge-app/commit/dedfa18c51825d98e08f12ce9502813e884f4086))

## [0.5.0](https://github.com/AgentKitProject/agentkitforge-app/compare/v0.4.1...v0.5.0) (2026-06-05)


### Features

* updating to new domain ([e979527](https://github.com/AgentKitProject/agentkitforge-app/commit/e979527bca678edacd2e0a066c98f58e47b5fafb))

## [0.4.1](https://github.com/AgentKitProject/agentkitforge-app/compare/v0.4.0...v0.4.1) (2026-06-02)


### Bug Fixes

* repair packaged AI runtime on macOS ([6fb4ec0](https://github.com/AgentKitProject/agentkitforge-app/commit/6fb4ec0e8676c08d932add12ec5398bdafe0d5b2))

## [0.4.0](https://github.com/AgentKitProject/agentkitforge-app/compare/v0.3.0...v0.4.0) (2026-06-02)


### Features

* add Windows Trusted Signing for release artifacts ([5b4f265](https://github.com/AgentKitProject/agentkitforge-app/commit/5b4f265ddb063bc23f82d36cf33e09da56ba52fd))

## [0.3.0](https://github.com/AgentKitProject/agentkitforge-app/compare/v0.2.1...v0.3.0) (2026-05-31)


### Features

* add all-platform app updater support ([bb5d2da](https://github.com/AgentKitProject/agentkitforge-app/commit/bb5d2da0646ea003db4a9116b5df5cd3060b63fe))

## [0.2.1](https://github.com/AgentKitProject/agentkitforge-app/compare/v0.2.0...v0.2.1) (2026-05-31)


### Bug Fixes

* adding signing/notarizing for macos release artifacts, improving workflow to ensure macos artifacts are signed/notaritzed ([492bea5](https://github.com/AgentKitProject/agentkitforge-app/commit/492bea5f3b1e47eec2fef9e2377b4af859439be3))

## [0.2.0](https://github.com/AgentKitProject/agentkitforge-app/compare/v0.1.1...v0.2.0) (2026-05-31)


### Features

* allowing app to run on all platforms ([21bb759](https://github.com/AgentKitProject/agentkitforge-app/commit/21bb7594a0ad7e4351162952194d40792f2af36e))

## [0.1.1](https://github.com/AgentKitProject/agentkitforge-app/compare/v0.1.0...v0.1.1) (2026-05-30)


### Bug Fixes

* add automatic release artifact mirroring ([3c49f0d](https://github.com/AgentKitProject/agentkitforge-app/commit/3c49f0deb6b4c8901548e8df31e5b986701c8ff4))

## 0.1.0 (2026-05-30)


### Features

* prepare initial app public preview ([84aad1d](https://github.com/AgentKitProject/agentkitforge-app/commit/84aad1d47b78b9434be8a8c93a13b9dbfce39cd2))


### Bug Fixes

* set initial app release baseline ([35c1227](https://github.com/AgentKitProject/agentkitforge-app/commit/35c122700de0fd75e174852d926010c56cecf89a))
* use npm core package ([ed5997c](https://github.com/AgentKitProject/agentkitforge-app/commit/ed5997c1b49da42cae102fe77706dbf03953da66))
* use npm core package ([5193c5d](https://github.com/AgentKitProject/agentkitforge-app/commit/5193c5d083a5a5127278c4ade59b2b18817261fa))

## v0.0.0 Public Preview

### Overview

AgentKitForge v0.1.0 Public Preview is the first desktop release for building, reviewing, using, importing, packaging, and installing portable Agent Kits on a local machine.

This release focuses on local-first workflows: users can create new kits, edit existing kits, run kits with their chosen AI provider, package kits for sharing, import kits from common sources, and export kit content into supported local agent tools.

### Major Features

- Local My Kits library for tracking Agent Kit folders without requiring an account.
- Agent Kit validation through `agentkitforge-core` validation profiles.
- Responsive AgentKitForge-branded desktop UI with light theme by default and optional dark mode.
- Settings for AI providers, storage folders, default behavior, appearance, security/privacy notes, and About links.
- Documentation links to AgentKitForge.com, Docs, and the Agent Kit Spec.
- Local-only settings and library persistence.

### AI Providers

AgentKitForge v0.1.0 supports configurable AI providers for Build and Use workflows:

- OpenAI
- Anthropic Claude
- Google Gemini
- Ollama
- Custom OpenAI-compatible providers

Known model lists are suggestions, not constraints. Users can enter custom model IDs for hosted, local, self-hosted, and gateway-backed providers.

### Build Workflows

- Build with AI for generating AgentKitDraft JSON from a user request.
- Iterative AI Draft Sessions for requesting revisions before saving a usable Agent Kit.
- Guided Builder for no-code/manual kit creation centered around forms and recommended Prepared Prompts.
- From Template for starter kits.
- From Draft JSON for rendering an existing AgentKitDraft.
- Edit with AI for loading an existing kit as a draft and requesting changes.
- Guided Editor for form-based editing of existing kits.

AI-generated drafts are not added to My Kits automatically. A draft becomes a usable Agent Kit only after the user clicks Save and renders it into a kit folder.

### Use Workflows

- Use a Prepared Prompt when a kit defines prepared prompts.
- Write a Custom Prompt for any kit, including kits with no prepared prompts.
- Render prompt inputs with validation and preview before running.
- Run with the selected/default AI provider.
- Validate before running when enabled.
- Copy responses.
- Download responses as Markdown or text.
- Prepare for Web Assistant by exporting a one-file Markdown bundle and starter prompt.

### Import and Export

Import supports:

- `.agentkit.zip` packages.
- Existing local Agent Kit folders.
- Git repositories using the user's local Git credentials for read-only clone access.

Package / Export supports:

- Full `.agentkit.zip` packages for importing into AgentKitForge, sharing, or later publishing.
- One-file Markdown bundles (`.onefile.md`) for manual upload or paste into web assistants.

Expected Windows release artifacts are produced under:

- `src-tauri/target/release/bundle/msi/`
- `src-tauri/target/release/bundle/nsis/`

Suggested release upload names:

- `AgentKitForge-0.1.0-setup.exe`
- `AgentKitForge-0.1.0-x64.msi`
- `checksums.txt`

### Local Agent Integrations

Install on Local Agent supports:

- Codex export: copies Agent Kit skills into a Codex-compatible skills folder.
- Claude Code export: exports the kit as a Claude Code plugin-style folder.

AgentKitForge writes files only. It does not launch Codex or Claude Code, restart those tools, or verify that the external runtime loaded exported content.

### CLI/Core Relationship

The desktop app wraps `agentkitforge-core` for deterministic kit operations such as validation, scaffolding, draft rendering, packaging, one-file export, context building, prepared prompt handling, artifact naming, and app-support helpers.

Runtime AI provider calls, provider settings, local API key storage, connection tests, and desktop UI workflows live in the app layer.

### Known Limitations

- No Agent Kit Market integration yet.
- No organization/private repository sync yet.
- Git import can use local Git credentials for read-only clone access, but there is no in-app OAuth flow or Git token storage.
- No auto-update support yet.
- Public Windows release artifacts are signed with Microsoft Artifact Signing / Trusted Signing in GitHub Actions. SmartScreen reputation may still build over time for early preview releases.
- macOS and Linux release packaging are future work unless built manually in those environments.
- File upload/RAG is not implemented for Use mode. Build with AI can use limited example input document support for source notes and metadata.
- Spreadsheet example document support is limited in v0.1. Text, Markdown, and CSV extraction are more reliable than Excel previews.
- Local and custom model quality varies. Structured JSON draft generation works best with providers/models that reliably return valid JSON.
- No streaming responses yet.
- No marketplace/org/account features.

### Security and Privacy Notes

- AgentKitForge is local-first and does not require an account.
- My Kits entries and app preferences are stored locally on the user's machine.
- Provider API keys are stored locally in this app's settings file on your machine, not in an OS keychain. Do not use shared or untrusted machines. You can clear stored keys from Settings.
- Provider and Git error details are redacted before display.
- Git repository import is read-only. AgentKitForge does not push commits, write to remotes, or execute repository scripts during import.
- Git imports disable interactive credential prompts, time out long-running clones, and skip symlinked files for safety.
- `.agentkit.zip` imports enforce v0.1 extraction limits to reduce zip bomb and oversized-package risk.
- Local model providers such as Ollama depend on the user's local server configuration and availability.
