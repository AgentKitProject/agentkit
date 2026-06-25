# Security CI Policy

This repository uses GitHub Actions security checks for the v0.1 release line.

## Blocking Checks

- `npm audit --audit-level=critical` fails on critical npm vulnerabilities.

## Non-Blocking Checks

- `npm audit --audit-level=high` runs as a visible report with `continue-on-error: true`.
- High, moderate, and low npm vulnerabilities are warning-only for v0.1.
- Dev-only dependency vulnerabilities and outdated dependencies are warning-only for v0.1.

## Why High npm Vulnerabilities Are Warning-Only for v0.1

AgentKitForge Core is still pre-release and uses a small TypeScript CLI dependency set. During v0.1, high npm audit results are reviewed manually so we can distinguish runtime risk from dev-tool or transitive noise without blocking every development PR.

This policy should tighten after the first public release. The intended direction is to fail on high runtime dependency vulnerabilities and keep dev-only advisories under explicit review.

## Secrets

Do not commit API keys, tokens, credentials, private certificates, local environment files, or provider secrets. Core does not require provider API keys; runtime provider calls belong in the app layer. Secret scanning is not currently enforced by this repository's GitHub Actions workflow.

## Agent Kit Input Safety

Agent Kit packages, folders, and manifests are treated as untrusted input. Manifest paths must resolve inside the kit root, IDs used in filesystem paths must be path-safe, and core does not execute declared or undeclared scripts. Packaging, context building, and target exports reject symbolic links, skip generated/dependency-heavy folders such as `exports/`, `.git`, `node_modules`, `dist`, and `build`, and use conservative file-count and byte limits.
