# Security CI Policy

AgentKitForge v0.1 uses a practical security gate for a Tauri, React, TypeScript, and Rust desktop app. The policy is intentionally strict for secrets and critical production dependency risk, while leaving noisy dependency classes as reports until the app has more release history.

## Blocking checks

CI fails on:

- Critical production npm vulnerabilities from `npm audit --audit-level=critical --omit=dev --package-lock-only`.
- RustSec advisories from `cargo audit` in `src-tauri`.

`cargo audit` does not provide a simple, stable severity threshold that cleanly maps to high/critical in this workflow, so RustSec currently fails on any reported advisory. This is stricter than the intended high/critical policy and can be relaxed later if severity filtering becomes reliable enough for this repo.

## Non-blocking checks

CI reports but does not initially fail on:

- High npm vulnerabilities.
- Moderate/medium npm vulnerabilities.
- Low vulnerabilities.
- Dev-only npm dependency vulnerabilities.
- Outdated dependencies.

High npm vulnerabilities are warning-only for v0.1 because frontend/Tauri dependency trees can produce noisy advisories in development-only tooling. Critical production advisories remain blocking.

## Future tightening

After v0.1, tighten the policy by:

- Failing on high production npm vulnerabilities.
- Adding explicit dev-only vulnerability review rules.
- Adding secret scanning once the preferred scanner and false-positive policy are settled.
- Adding CodeQL once the app has a stable code-scanning baseline.
- Adding dependency freshness checks.
- Adding scheduled scans.
