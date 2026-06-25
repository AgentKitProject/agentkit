# Portability Notes

AgentKitForge is preparing for macOS and Linux support.

Current support status:

- Windows: supported release target.
- macOS: release artifact automation signs and notarizes public DMG artifacts; runtime validation remains required before broad promotion.
- Linux: build smoke validation is in progress; not a public release target yet.

## Backend Bridge Runtime

`@agentkitforge/core` remains the canonical Agent Kit implementation. The desktop app keeps a thin Tauri/Rust command layer and invokes small Node-based backend bridge scripts for core operations.

For packaged builds, `npm run build:backend` prepares:

- self-contained bundled bridge files in `src-tauri/backend-dist/`
- bundled `@agentkitforge/core` logic and JavaScript dependencies inside those bridge bundles
- a platform-specific Node sidecar in `src-tauri/binaries/`

The packaged app does not require user-installed Node and does not require a runtime `node_modules` folder.

Installed macOS apps launch the bundled Node executable from `AgentKitForge.app/Contents/MacOS/node`. Public macOS release workflows sign this sidecar with hardened runtime and the V8-compatible entitlements in `src-tauri/entitlements/node-sidecar.entitlements.plist`:

- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`

The app does not pass `--jitless` and does not rely on `NODE_OPTIONS=--jitless`. `--jitless` disables WebAssembly in this runtime path and breaks Node fetch/Undici, so the packaged sidecar must be signed with the entitlements V8 needs instead.

## Node Sidecar

Tauri bundles the sidecar from `src-tauri/binaries/node-*` using the `bundle.externalBin` configuration. `npm run build:backend` copies the Node executable used for the build into the expected Tauri sidecar filename for the current platform.

Platform sidecar names follow Tauri target triples:

- `src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`
- `src-tauri/binaries/node-aarch64-pc-windows-msvc.exe`
- `src-tauri/binaries/node-x86_64-apple-darwin`
- `src-tauri/binaries/node-aarch64-apple-darwin`
- `src-tauri/binaries/node-x86_64-unknown-linux-gnu`
- `src-tauri/binaries/node-aarch64-unknown-linux-gnu`

`npm run build:backend` creates the sidecar for the OS and architecture running the build. By default it copies the Node executable running the build, but release/local packaging can set:

```text
AGENTKITFORGE_NODE_SIDECAR=/absolute/path/to/node
```

Use this when the build `node` is not suitable as a standalone sidecar. On macOS, `build:backend` rejects Node binaries with unresolved `@rpath` dynamic-library dependencies, such as Homebrew Node builds that require `libnode.*.dylib`, because Tauri's `externalBin` packaging copies the sidecar executable but not Homebrew's shared library tree. If no override is set, local macOS builds try the current Node first, then a bundled Node from `/Applications/AgentKitForge.app/Contents/MacOS/node`, then an existing prepared `src-tauri/binaries/node-*` sidecar. The backend and Tauri sidecar checks also execute the copied Node with `--version` so broken sidecars fail in CI before release artifacts are uploaded.

On macOS, `npm run build:tauri` defaults to `tauri build --bundles app` for local builds. This avoids Tauri's generated DMG wrapper path, which can fail in local non-release shells even when the app bundle is valid. After a successful local app build, the wrapper ad-hoc signs the app bundle with the stable `com.agentkitforge.desktop` identifier and signs the Node sidecar with the same V8 entitlements used by release builds. This gives local installed DMGs a stable Keychain identity for AgentKitProject secure storage testing. Release workflows still own Developer ID signing, DMG creation, notarization, stapling, and verification. To manually create a local DMG for inspection, run the generated `src-tauri/target/release/bundle/dmg/bundle_dmg.sh` script from a normal shell after the `.app` bundle exists.

## macOS Signing and Notarization

Public macOS release artifacts require Apple Developer ID signing and notarization. Release workflows import the Developer ID certificate into a temporary keychain, build with Tauri signing/notarization environment variables, staple the notarization ticket, and verify with `codesign`, `xcrun stapler`, and `spctl` before upload.

The website mirror is dispatched only after the signed/notarized macOS artifact is uploaded to the GitHub Release and verified in the release-asset manifest. If macOS signing, notarization, stapling, or verification fails, the website remains on the previous valid release.

The canonical Forge website domain is `https://forge.agentkitproject.com`. The legacy `https://agentkitforge.com` domain remains supported during migration, including as a fallback updater endpoint for builds that support multiple updater endpoints. Existing installed apps may continue checking the old endpoint until updated. AgentKitForge remains local-first; AgentKitProject login, Market integration, and future Auto integration are optional and are not part of portability requirements.

Optional account/profile UX is owned by `https://profile.agentkitproject.com/account`. The desktop app exposes account state in a top-level Account view and persistent sidebar account block, but does not require login for local workflows and must not store account tokens in plaintext settings files. Account connection uses WorkOS/AuthKit device-code auth when a build includes the public `AGENTKITPROJECT_WORKOS_CLIENT_ID`; otherwise the app remains disconnected and local-first. Dev launches may provide this public client ID as a runtime environment variable. Packaged builds must provide it during `tauri build` so Rust can embed it via compile-time env. It is not a Vite frontend variable and is not a secret.

Connected account state must be backed by OS secure storage. If public account metadata is present but the secure AgentKitProject token/session is missing, Forge reports reconnect-required instead of connected. The `check_agentkitproject_account_session` Tauri command reports only safe booleans such as metadata presence, token presence, token expiry when known, and secure-storage availability; it never returns token values, auth codes, prompts, or secrets.

Manual `.agentkit.zip` import remains fully local and account-optional. Downloaded packages, including packages from AgentKitMarket, are validated locally, checked for unsafe archive paths, extracted only into approved local destinations, and added to My Kits without cloud upload or Market/API calls.

The optional AgentKitMarket integration opens `https://market.agentkitproject.com/kits` in the system browser and routes users back to the local `.agentkit.zip` importer. Signed-in users can also directly import approved hosted Market kits by URL, slug, kit ID, or a Market **Open in Forge** deep link. Forge requests a short-lived download URL with the AgentKitProject bearer token, downloads the `.agentkit.zip` to an app-controlled temporary location, verifies checksum metadata when provided, validates locally, extracts into the default Forge library, and adds the kit to My Kits. Signed-in users can submit local kits to hosted AgentKitMarket; Forge validates locally, packages the selected kit, requests a Market upload URL with the user's AgentKitProject bearer session, uploads the package, starts Market validation, and records the returned submission id/status/link while Market admin review remains required. The `agentkitforge://market/import` deep link carries only `market` plus `kit` or `kitId` references; it must not carry tokens, admin keys, service keys, signed download URLs, or package URLs, and Forge asks the user to confirm before downloading. Downloading from hosted Market may require an AgentKitProject account, but importing a downloaded package in Forge does not. Hosted submit, background sync, and AgentKitAuto must not become portability requirements for local Forge workflows.

Forge's integration model must support hosted AgentKitProject services and private/self-hosted company services. Hosted AgentKitMarket uses the optional AgentKitProject account. Private Market and Auto services use their own credentials and identity provider, and an AgentKitProject account is not required unless that service chooses it. Future service credentials must be scoped per connection and stored in OS secure storage/keychain; plaintext settings may contain only public connection metadata. Planned discovery endpoints are `/.well-known/agentkit-market.json` and `/.well-known/agentkit-auto.json`, but portable local workflows must not require them.

Required GitHub secrets:

- `APPLE_CERTIFICATE_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_TEAM_ID`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER_ID`
- `APPLE_API_KEY`

Local development builds may still be unsigned. macOS signing is separate from Windows signing and Tauri updater signing.

## Runtime Resolution

Development builds use:

1. `AGENTKITFORGE_NODE`, when set.
2. System `node` on `PATH`.
3. Source bridge scripts under `src-tauri/backend/`.

Packaged builds use:

1. Bundled Node sidecar.
2. Bundled bridge resources under `backend-dist/`.

Packaged builds do not fall back to system Node. Missing runtime files and execution failures are reported separately:

```text
Bundled Node runtime was not found.
Bundled backend runtime files were not found.
Bundled Node runtime failed to start.
Backend runtime failed. See diagnostics.
```

The Tauri command `check_packaged_runtime_files` returns JSON-safe diagnostics for packaged runtime issues. It reports the current executable path, resource directory, resolved Node path, `backend-dist` path, required backend file presence, `node --version`, normal `node --check generate-agent-kit-draft.mjs`, and a safe fetch smoke-test result. Diagnostics must not include provider API keys, prompts, request bodies, or other secrets.

## Developer Overrides

Source bridge scripts still support local core development with:

- `AGENTKITFORGE_ALLOW_DEV_OVERRIDES=1`
- `AGENTKITFORGE_CORE_PATH=/path/to/agentkitforge-core`

Generated packaged bridge bundles disable those overrides.

## Opening Files and Links

Folder and documentation link opening use Tauri's opener plugin instead of direct `explorer`, `open`, `xdg-open`, or `cmd` shell commands.

## CI Smoke Coverage

The smoke workflow runs platform build validation on:

- `windows-latest`
- `ubuntu-latest`
- `macos-latest`

Each matrix job runs:

1. `npm ci`
2. `npm run build:backend`
3. `npm run check:backend`
4. `npm run check`
5. `npm run build:tauri`
6. `npm run check:tauri-sidecar`

Linux jobs install the WebKitGTK/AppIndicator packages required for Tauri builds.

These jobs verify `backend-dist` exists before Tauri packaging and verify the Tauri build output references the backend runtime resources and platform sidecar where practical. They do not publish macOS or Linux artifacts.

The macOS smoke job builds the `.app` bundle only. Release artifact workflows are responsible for Developer ID signing, DMG creation, notarization, stapling, and release upload.
