# Versioning

AgentKitForge Core uses Semantic Versioning.

Version format:

```text
MAJOR.MINOR.PATCH
```

## Pre-1.0 Policy

Before `1.0.0`, the public API and Agent Kit schema are still stabilizing.

- Minor versions, such as `0.2.0`, may include breaking changes.
- Patch versions, such as `0.1.1`, are for fixes, security fixes, documentation corrections, and compatible improvements.
- Breaking changes should be documented clearly in release notes.

Release Please uses Conventional Commits to determine version bumps:

- `feat:` creates a minor release.
- `fix:` creates a patch release.
- `security:` creates a patch release.
- Breaking changes before `1.0.0` create a minor release, but must be documented in release notes and any affected spec docs.

## Agent Kit Schema Compatibility

Agent Kit manifests include `schemaVersion`.

Current public preview schema:

```yaml
schemaVersion: "0.1"
```

Compatibility policy during public preview:

- `schemaVersion: "0.1"` is the v0.1 public preview schema.
- Compatible validator improvements may ship in patch releases.
- Breaking schema changes should use a new schema version and be documented in `SPEC.md`, `CHANGELOG.md`, and release notes.
- Deprecated fields should receive a migration note when practical.

## Release Target

The current release target is `v0.1.0 Public Preview`.
