# Security Policy

## Reporting Vulnerabilities

Do not report security vulnerabilities in public issues.

Use GitHub private vulnerability reporting if it is enabled for this repository.

Fallback contact: `security@agentkitforge.com` (TODO: confirm this mailbox is active before relying on it for public intake).

## Supported Versions

| Version | Supported |
| --- | --- |
| v0.1.x | Supported once released |

## Security-Sensitive Areas

Please treat these areas as security-sensitive:

- Provider API keys.
- Local settings storage.
- Untrusted Agent Kit package import.
- Untrusted folder import.
- Git repository import.
- Tauri filesystem access and capabilities.
- Install/export destinations for local agent tools.

Changes in these areas should include clear rationale, tests where practical, and review of possible secret exposure, path traversal, unsafe overwrite, and untrusted input risks.
