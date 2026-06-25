# Updates

AgentKitForge uses the Tauri updater for desktop updates on Windows, macOS, and Linux.

## Update Endpoint

New app builds check the canonical Forge endpoint first:

```text
https://forge.agentkitproject.com/updates/latest.json
```

The legacy endpoint remains configured as a fallback where supported:

```text
https://agentkitforge.com/updates/latest.json
```

The private infrastructure repository owns these endpoints and mirrors only release artifacts that have completed the app release workflow. Existing installed apps may continue checking `https://agentkitforge.com/updates/latest.json` until they update to a build with the canonical endpoint list.

## App Behavior

- AgentKitForge checks for updates shortly after startup.
- Startup checks are rate-limited to at most once every 24 hours.
- Users can manually check for updates in Settings.
- Updates are never installed silently.
- When an update is available, the user must click **Update now**.
- The updater may restart or relaunch AgentKitForge after installation, depending on platform behavior.

## Signing

Tauri updater signing is separate from:

- Windows code signing / Microsoft Trusted Signing
- macOS Developer ID signing and notarization
- any future Tauri updater or channel policy changes

Windows release installers are Authenticode signed with Microsoft Artifact Signing / Trusted Signing before checksums and upload, but those Authenticode signatures do not replace Tauri updater `.sig` files. The workflow uses Azure OIDC through GitHub Actions and does not store Azure client secrets in this app repository. Microsoft Defender SmartScreen reputation may still build over time even for signed installers.

The updater public key is committed in the Tauri app configuration. The updater private key must never be committed and must only be provided to release workflows through GitHub secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key is password-protected

Release builds use `src-tauri/tauri.updater.conf.json` to enable updater artifact creation and fail if the updater signing private key is missing. Normal local `npm run build:tauri` builds the app without creating updater artifacts unless you explicitly pass that config overlay and provide the private key.

## Platform Manifest

During app releases, the app workflow uploads `AgentKitForge-${version}-update-metadata.json` to the GitHub Release. The private infra repo uses that metadata plus the mirrored release assets to publish:

```text
https://forge.agentkitproject.com/updates/latest.json
https://agentkitforge.com/updates/latest.json
```

`https://forge.agentkitproject.com` is the canonical Forge domain. `https://agentkitforge.com` remains supported during migration for backward compatibility with existing installs. The metadata contains the release version, tag, notes, publication time, and one platform entry per completed updater artifact. Platform entries use Tauri's default keys such as:

- `windows-x86_64`
- `darwin-x86_64`
- `darwin-aarch64`
- `linux-x86_64`

`latest.json` should include only platforms with complete updater artifacts:

- Windows: installer artifact and `.sig`
- macOS: updater archive and `.sig`, after Developer ID signing and notarization
- Linux: AppImage artifact and `.sig`

Tauri selects the matching platform entry from the shared endpoint.

Updater signatures are mandatory. They are distinct from SHA-256 checksum files: checksums help users verify downloads, while Tauri updater signatures prove that an update artifact was signed with the private updater key trusted by the installed app.

Do not rotate the updater signing key casually. Existing installs trust the public key embedded in the app, so key rotation requires a planned migration release signed by the old updater key.

## Local Development

Local development builds do not create updater signatures by default. To test updater artifact creation locally, run Tauri with `src-tauri/tauri.updater.conf.json` and set `TAURI_SIGNING_PRIVATE_KEY`. Unsigned local builds can still run, but they should not be published as public update artifacts.

AgentKitForge remains local-first. AgentKitProject login, Market integration, and future Auto integration are optional and are not part of updater behavior.
