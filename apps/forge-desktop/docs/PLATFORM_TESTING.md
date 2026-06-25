# Platform Testing

Use this checklist when validating AgentKitForge runtime behavior on each desktop platform. This is manual runtime validation, not release publishing guidance.

## Status Labels

- **Supported**: Public release target with expected installer/package behavior and documented support.
- **Preview**: Feature or platform is usable for early testers, but may still have packaging, signing, or support gaps.
- **Experimental**: Useful for development validation, but behavior may change and issues are expected.
- **Build-only**: CI/build smoke target only. Do not treat as a supported user download.

## Current Platform Status

| Platform | Status | Notes |
| --- | --- | --- |
| Windows | Supported | Primary v0.1 release target. Windows installers are built, Authenticode signed with Microsoft Artifact Signing / Trusted Signing, and verified in release automation. |
| macOS | Preview | Public release DMG artifacts are Developer ID signed, notarized, stapled, and verified in release automation. Runtime validation remains required before marking fully supported. |
| Linux | Build-only | Build smoke validation is in progress. Public distro packaging and dependency guidance are not finalized yet. |

## Runtime Checklist

Run the full checklist on each platform before changing its status.

### Windows

- [ ] For release artifacts, verify the setup `.exe` and `.msi` were signed with Microsoft Artifact Signing / Trusted Signing before checksums were generated.
- [ ] Confirm `signtool verify /pa /tw /v` passes for the downloaded setup `.exe` and `.msi`.
- [ ] Confirm the Windows Tauri updater `.sig` files are present and are treated separately from Authenticode signatures.
- [ ] Install the current Windows installer.
- [ ] Open AgentKitForge from the installed app.
- [ ] Open Settings and verify provider, folder, appearance, privacy, and About sections.
- [ ] Open My Kits and verify existing kits display correctly.
- [ ] Build with AI using a configured provider.
- [ ] Create a kit with Guided Builder.
- [ ] Use a kit with a custom prompt.
- [ ] Use a kit with a prepared prompt and required inputs.
- [ ] Import a `.agentkit.zip` package.
- [ ] Import an existing Agent Kit folder.
- [ ] Import an Agent Kit from a Git repository.
- [ ] Create Package / Export outputs.
- [ ] Export to Install on Local Agent targets.
- [ ] Open generated folders/files from app buttons.

### macOS

- [ ] Build the app on `macos-latest` or a local macOS machine.
- [ ] For release artifacts, verify the DMG was Developer ID signed, notarized, and stapled.
- [ ] Confirm website mirroring occurred only after the signed/notarized DMG and checksum were uploaded and verified.
- [ ] Open the downloaded DMG and confirm macOS does not show "AgentKitForge is damaged and can't be opened."
- [ ] Open the built app.
- [ ] Open Settings and verify provider, folder, appearance, privacy, and About sections.
- [ ] Open My Kits and verify existing kits display correctly.
- [ ] Build with AI using a configured provider.
- [ ] Create a kit with Guided Builder.
- [ ] Use a kit with a custom prompt.
- [ ] Use a kit with a prepared prompt and required inputs.
- [ ] Import a `.agentkit.zip` package.
- [ ] Import an existing Agent Kit folder.
- [ ] Import an Agent Kit from a Git repository.
- [ ] Create Package / Export outputs.
- [ ] Export to Install on Local Agent targets.
- [ ] Open generated folders/files from app buttons.

### Linux

- [ ] Build the app on `ubuntu-latest` or a local Linux machine with Tauri/WebKitGTK prerequisites installed.
- [ ] Open the built app.
- [ ] Open Settings and verify provider, folder, appearance, privacy, and About sections.
- [ ] Open My Kits and verify existing kits display correctly.
- [ ] Build with AI using a configured provider.
- [ ] Create a kit with Guided Builder.
- [ ] Use a kit with a custom prompt.
- [ ] Use a kit with a prepared prompt and required inputs.
- [ ] Import a `.agentkit.zip` package.
- [ ] Import an existing Agent Kit folder.
- [ ] Import an Agent Kit from a Git repository.
- [ ] Create Package / Export outputs.
- [ ] Export to Install on Local Agent targets.
- [ ] Open generated folders/files from app buttons.

## Known Platform Caveats

- Git must be installed and available on `PATH` for Git repository imports.
- Private Git imports use the user's local Git credentials; AgentKitForge does not store Git provider tokens.
- Windows public release artifacts require Microsoft Artifact Signing / Trusted Signing. Local development builds may still be unsigned, and Microsoft Defender SmartScreen reputation can still build over time even for signed installers.
- macOS public release artifacts require Developer ID signing and notarization. Local development builds may still be unsigned and can be blocked or warned by Gatekeeper.
- Linux package dependencies vary by distro. CI installs the Ubuntu WebKitGTK/AppIndicator packages needed for Tauri build smoke validation, but public Linux package support is not finalized.
- Local agent destination folders differ by operating system and user tool configuration.
