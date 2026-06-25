# Contributing to AgentKitForge Core

Thanks for helping improve AgentKitForge Core. This repository is the public contribution target for the core Agent Kit toolkit: package/spec validation, CLI workflows, packaging, prompt rendering, context building, and target exports.

## Local Setup

```bash
npm install
npm run build
npm test
npm run smoke
```

Use Node 24 or newer for CI parity.

## Contribution Scope

Good contribution areas include:

- Core Agent Kit validation
- Agent Kit package structure and specification docs
- CLI commands and command behavior
- Exporters and target adapters
- Prepared Prompts
- Context Builder
- Draft/session data models that do not call providers
- Tests and fixtures
- Documentation

Out of scope for this repository:

- AgentKitForge Marketplace
- Backend services
- Cloud infrastructure
- Desktop app UI
- Provider network clients or API key handling

## Open an Issue or Discussion First

Please open an issue or discussion before starting work on:

- Breaking Agent Kit schema changes
- New canonical package sections
- Security-sensitive filesystem, import, packaging, or export behavior
- Major CLI changes
- New target adapters with uncertain install semantics

## Development Guidelines

- Keep core provider-neutral. Do not add OpenAI, Anthropic, Gemini, Ollama, or other provider calls here.
- Treat Agent Kits as untrusted input.
- Keep generated outputs deterministic where practical.
- Add or update tests for validation, packaging, rendering, and CLI behavior.
- Update documentation when public APIs, CLI commands, package structure, or security behavior changes.

## Conventional Commits

Use Conventional Commits for all pull requests. Release Please uses commit messages to generate release PRs, changelog entries, Git tags, and GitHub Releases.

Examples:

```text
feat: add Cursor export adapter
fix: prevent path traversal in kit validation
docs: update CLI guide
security: harden zip extraction
```

Version impact:

- `feat:` creates a minor release.
- `fix:` creates a patch release.
- `security:` creates a patch release.
- Breaking changes use `!` or a `BREAKING CHANGE:` footer. Before `1.0.0`, breaking changes are minor releases but must be documented.

## Pull Request Checklist

Before opening a pull request, run:

```bash
npm run build
npm test
npm run smoke
```

Also confirm:

- No secrets or local credentials are included.
- Security-sensitive path or filesystem changes have tests.
- Agent Kit schema changes are documented in `SPEC.md` and `VERSIONING.md` if applicable.
- CLI changes are documented in `CLI.md` and `README.md` if user-facing.
