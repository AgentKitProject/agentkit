# Release Process

This process is for AgentKitForge desktop app releases.

## Before Release

1. Confirm the target version in:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
   - About screen
   - `RELEASE_NOTES.md`
2. Review `RELEASE_CHECKLIST.md`.
3. Confirm known limitations are still accurate.
4. Confirm code signing and auto-update status are accurately documented.

## Build

Run:

```powershell
npm run build:backend
npm run check
npm run smoke
npm run build:tauri
```

Windows artifacts are expected under:

- `src-tauri/target/release/bundle/msi/`
- `src-tauri/target/release/bundle/nsis/`

macOS artifacts, when built on macOS, are expected under:

- `src-tauri/target/release/bundle/dmg/`
- `src-tauri/target/release/bundle/macos/`

Installed macOS releases use the bundled Node sidecar at `AgentKitForge.app/Contents/MacOS/node` for backend bridge scripts and do not require system Node. The release workflow signs that Node sidecar with hardened runtime plus V8-compatible entitlements from `src-tauri/entitlements/node-sidecar.entitlements.plist`. Packaged macOS backend launches do not use `--jitless`, because that disables WebAssembly and breaks Node fetch/Undici. Runtime diagnostics are available through the Tauri command `check_packaged_runtime_files` for installer/runtime investigation.

Linux artifacts, when built on Linux, are expected under:

- `src-tauri/target/release/bundle/appimage/`
- `src-tauri/target/release/bundle/deb/`
- `src-tauri/target/release/bundle/rpm/`

Suggested public artifact names:

- `AgentKitForge-0.1.0-setup.exe`
- `AgentKitForge-0.1.0-x64.msi`
- `checksums.txt`

Public Windows release artifacts are signed in GitHub Actions with Microsoft Artifact Signing / Trusted Signing after the installers are collected and renamed, and before checksums, GitHub Release upload, updater metadata generation, or infra mirror dispatch. Local development builds remain unsigned.

## Release Please

Release PRs are generated automatically by Release Please from Conventional Commits on `main`.

Release Please updates:

- `package.json`
- `package-lock.json`
- `src-tauri/tauri.conf.json`
- `RELEASE_NOTES.md`

The current release target is `v0.1.0 Public Preview`.

Release happens when the Release Please PR is merged. Release Please creates the git tag and GitHub Release. GitHub Release titles use:

```text
AgentKitForge vX.Y.Z
```

Version rules:

- `feat:` creates a minor release.
- `fix:` and `fix(security):` create a patch release.
- Breaking changes before `1.0.0` are treated as minor releases and must be documented.

When Release Please creates a GitHub Release, the same `release-please.yml` workflow builds and uploads release artifacts. This avoids relying on a separate `release: published` workflow trigger, which GitHub can suppress when the release is created with `GITHUB_TOKEN`.

The GitHub Release may exist before all installer artifacts are ready. That is acceptable. The website mirror is gated on the artifact jobs, checksums, signing/notarization checks, upload completion, and a final release-asset verification step.

AgentKitForge uses the Tauri updater for in-app updates. New public releases prefer `https://forge.agentkitproject.com/updates/latest.json` and retain `https://agentkitforge.com/updates/latest.json` as a legacy fallback where supported. The app release workflow uploads `AgentKitForge-${version}-update-metadata.json`, and the private infra repo uses that metadata to generate `/updates/latest.json` on both domains during migration. The metadata and endpoint should include only platforms whose update artifacts, signatures, checksums, and platform-specific signing/notarization checks completed successfully.

AgentKitForge remains local-first. AgentKitProject account/profile UX is optional and lives at `https://profile.agentkitproject.com/account`. Desktop account connection uses WorkOS/AuthKit device-code auth when the release build includes the public `AGENTKITPROJECT_WORKOS_CLIENT_ID`; no client secret is embedded in the app. Configure that value as a GitHub repository variable, not a secret, so release workflows can pass it into `tauri build` where Rust embeds it as compile-time env. Release workflows fail early if this public variable is missing. If the public client ID is omitted in a dev/smoke build, the app must stay disconnected rather than fake connected state. AgentKitMarket and AgentKitAuto integrations are optional future bridge phases and must not become prerequisites for local Forge release validation.

Release validation should keep manual `.agentkit.zip` import local-first: imports must work while signed out, reject unsafe archives, avoid executing package contents, and avoid Market/API calls or background sync. Direct Market browse/import is not part of release validation yet.

## Core Dependency

The desktop app consumes `@agentkitforge/core` from npm using semver.

Current app dependency format:

```json
"@agentkitforge/core": "^0.2.0"
```

Core package publishing is handled separately from the app release process.

## Checksums

Generate SHA-256 checksums for the final upload filenames.

Example PowerShell command after copying/renaming artifacts into a release folder:

```powershell
Get-FileHash .\AgentKitForge-0.1.0-setup.exe, .\AgentKitForge-0.1.0-x64.msi -Algorithm SHA256 |
  ForEach-Object { "$($_.Hash)  $([System.IO.Path]::GetFileName($_.Path))" } |
  Set-Content .\checksums.txt
```

For Windows releases, generate checksums only after Microsoft Artifact Signing / Trusted Signing and Authenticode verification complete. Signing changes the installer bytes, so pre-signing checksums are invalid for public release assets.

## Windows Code Signing

Windows user-facing release artifacts are Authenticode signed with Microsoft Artifact Signing / Trusted Signing in the Windows release jobs:

- `AgentKitForge-${version}-setup.exe`
- `AgentKitForge-${version}-x64.msi`

The workflow authenticates to Azure with GitHub Actions OIDC through `azure/login`; it does not store an Azure client secret or any long-lived Azure credential in the app repository. Configure these values as repository variables where practical:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `TRUSTED_SIGNING_ACCOUNT_NAME`
- `TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `TRUSTED_SIGNING_ENDPOINT`

The Azure principal used by OIDC must have permission to sign with the Trusted Signing certificate profile, such as the certificate profile signer role. The workflow signs only after the Windows installers and Tauri updater `.sig` files have been collected into `release-assets`, then verifies the `.exe` and `.msi` with SignTool before checksum generation and upload.

Windows Authenticode signing is separate from Tauri updater signing. Authenticode proves publisher identity and installer integrity to Windows, while Tauri updater `.sig` files are verified by installed AgentKitForge apps before applying updates. Do not replace updater `.sig` files with Authenticode signatures.

Signed Windows apps can still see Microsoft Defender SmartScreen warnings until publisher/application reputation builds over time. A valid signature removes the unknown-publisher condition, but reputation is not instant.

## Release Artifacts

1. Release Please publishes the GitHub Release and tag.
2. The `release-please.yml` workflow runs a dependent `build-release-artifacts` job when a release was created.
3. The automatic job builds signed Windows installers on `windows-latest`, signed/notarized macOS DMG artifacts on `macos-latest`, and Linux packages on `ubuntu-latest`.
4. The job uploads these assets to the GitHub Release:
   - `AgentKitForge-${version}-setup.exe`
   - `AgentKitForge-${version}-x64.msi`
   - `AgentKitForge-${version}-setup.exe.sig`
   - `AgentKitForge-${version}-x64.msi.sig`
   - `AgentKitForge-${version}-windows-checksums.txt`
   - `AgentKitForge-${version}-macos-${arch}.dmg`
   - `AgentKitForge-${version}-macos-${arch}.app.tar.gz`
   - `AgentKitForge-${version}-macos-${arch}.app.tar.gz.sig`
   - `AgentKitForge-${version}-macos-checksums.txt`
   - `AgentKitForge-${version}-linux-x86_64.AppImage`
   - `AgentKitForge-${version}-linux-x86_64.AppImage.sig`
   - `AgentKitForge-${version}-linux-amd64.deb`
   - `AgentKitForge-${version}-linux-x86_64.rpm`
   - `AgentKitForge-${version}-linux-checksums.txt`
   - `RELEASE_NOTES.md`
5. Each platform job writes an artifact manifest listing the files it uploaded.
6. A final pre-dispatch verification job confirms that:
   - each required/selected platform produced a manifest
   - every selected platform has a checksum file
   - every manifest-listed artifact exists on the GitHub Release
   - every updater metadata platform entry has both a URL asset and matching `.sig` asset
   - Windows installers were Authenticode signed with Microsoft Artifact Signing / Trusted Signing and verified with SignTool before upload
   - macOS artifacts were signed, notarized, stapled, and Gatekeeper-verified before upload
7. The workflow uploads `AgentKitForge-${version}-update-metadata.json` to the GitHub Release.
8. Only after verification passes, the job dispatches the private infra repo with event type `app-release-published`.
9. The private infra repo mirrors the artifacts to `forge.agentkitproject.com`, keeps `agentkitforge.com` available during migration, and publishes `/updates/latest.json`.

The app repo does not store AWS credentials and does not upload directly to S3. Website/S3 mirroring is owned by the private `AgentKitProject/agentkitforge-infra` repository.

Set `AGENTKIT_INFRA_DISPATCH_TOKEN` in this public app repository with the minimum GitHub permissions needed to call `repository_dispatch` on the private infra repo. If this secret is missing, artifact upload still completes, but automatic release runs fail at the infra dispatch requirement so website mirroring is not silently skipped.

`release-artifacts.yml` is manual fallback only. Use it to rebuild or replace assets for an existing GitHub Release by providing the release version. The fallback accepts a `platforms` input:

- `windows`
- `macos`
- `linux`
- `all`

Manual fallback runs verify the release exists, build/upload selected platform artifacts, generate per-platform SHA-256 checksum files, verify uploaded assets, and dispatch the infra mirror workflow when `AGENTKIT_INFRA_DISPATCH_TOKEN` is available. The dispatch payload includes the selected platform list and artifact names.

Do not point the website at artifacts until they exist and the infra mirror has completed. If any artifact build, signing/notarization step, checksum generation, upload, or pre-dispatch verification fails, the app workflow does not dispatch the private infra mirror and the public website should remain on the previous valid release.

## Tauri Updater

Updater artifacts are generated by Tauri during release builds with `bundle.createUpdaterArtifacts` enabled through `src-tauri/tauri.updater.conf.json`. Normal local builds do not create updater artifacts unless that config overlay is passed explicitly. Versions are derived dynamically from the Release Please output, the release tag, or the manual workflow input; release artifact workflows must not hardcode a version. Release workflows require:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key is password-protected

The updater private key must never be committed. Updater signatures are mandatory and distinct from SHA-256 checksums: checksums support download verification, while Tauri updater signatures are what the installed app verifies before installation. Checksums are generated after updater artifacts and signatures are created. The website update manifest should include only complete platform entries; if macOS is included, its app and DMG verification must pass before mirroring. Rotating the updater key requires a migration plan because already-installed apps trust the embedded public key.

## Current Release Caveats

- Windows release artifacts are signed with Microsoft Artifact Signing / Trusted Signing in GitHub Actions before checksums are generated. Local development builds are unsigned.
- Windows signing uses Azure OIDC and does not require Azure client secrets or long-lived Azure credentials in this repository.
- Windows Authenticode signing is separate from Tauri updater signing. The Windows `.sig` files uploaded with release assets remain Tauri updater signatures.
- Microsoft Defender SmartScreen reputation can still build over time even when installers are signed with a valid Trusted Signing certificate profile.
- macOS public release artifacts are signed with Apple Developer ID, notarized with App Store Connect API key credentials, stapled, and verified before upload.
- macOS downloads are mirrored to the website only after Developer ID signing and notarization pass.
- macOS signing is separate from Windows signing and separate from Tauri updater signing.
- Downloaded macOS artifacts should no longer show the "damaged and can't be opened" Gatekeeper error once notarization succeeds and the ticket is stapled.
- In-app updates are configured through the Tauri updater. New builds check `forge.agentkitproject.com` first, keep `agentkitforge.com` as a legacy fallback where supported, and require the user to approve installation.
- Local macOS development builds may still be unsigned and can be blocked or warned by Gatekeeper.
- Linux artifacts are unsigned except for SHA-256 checksums and Tauri updater signatures unless a separate package-signing process is configured.
- Linux update entries should be mirrored only when the AppImage and updater signature are both present.
- AgentKitForge infrastructure and marketplace/backend release work lives outside this public app repository.
