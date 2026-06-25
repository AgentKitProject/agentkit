# Security CI Policy

AgentKitForge uses automated checks to catch secrets, vulnerable dependencies, and release-blocking security issues before code is merged.

## Blocking checks

The following findings block pull requests and releases:

- Detected secrets
- Critical npm vulnerabilities
- High or critical RustSec vulnerabilities, where Rust is used
- High or critical CodeQL findings once CodeQL is enabled for the repository
- Security issues that can cause path traversal, unsafe file writes, credential exposure, or destructive filesystem behavior

## Warning-only checks for v0.1

The following findings are reported but do not automatically block release during the v0.1 public preview period:

- High npm vulnerabilities
- Medium and low vulnerabilities
- Dev-only dependency vulnerabilities
- Outdated dependencies
- Informational static-analysis findings

These may still be fixed before release if they affect runtime behavior or user security.

## CodeQL

CodeQL is intended to become a required check once this repository is public or GitHub code scanning is available for the repository.

Until then, required checks are:

- build/test
- smoke tests
- secret scanning
- critical dependency audits

## Triage policy

Security findings are triaged as:

- Critical: must fix before release
- High: normally fix before release unless clearly not exploitable
- Medium: fix soon or document
- Low: backlog

## Release rule

A release cannot be published if any blocking security check fails.
