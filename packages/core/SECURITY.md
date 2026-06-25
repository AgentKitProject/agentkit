# Security Policy

AgentKitForge Core treats Agent Kit folders, manifests, packages, prepared prompts, and target exports as untrusted input.

## Reporting Vulnerabilities

Please do not report security vulnerabilities in public GitHub issues.

Use GitHub private vulnerability reporting if it is enabled for this repository. If private reporting is not available, contact:

`security@agentkitforge.com`

TODO: Confirm this address is active before public release.

## Supported Versions

| Version | Supported |
| --- | --- |
| v0.1.x Public Preview | Supported after release |

## Security Scope

Security-sensitive areas include:

- Path traversal and unsafe file reads/writes
- Package import, export, and cleanup behavior
- ZIP packaging behavior
- Target exports for Codex and Claude Code
- Prepared Prompt rendering and unresolved variables
- Handling of `scripts/`
- Handling of symlinks and large/untrusted package trees

Core does not execute Agent Kit scripts and does not store provider API keys.
