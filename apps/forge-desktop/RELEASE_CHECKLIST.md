# AgentKitForge v0.1.0 Public Preview Release Checklist

## Version and Metadata

- [ ] Confirm `package.json` version is `0.1.0`.
- [ ] Confirm `src-tauri/Cargo.toml` version is `0.1.0`.
- [ ] Confirm `src-tauri/tauri.conf.json` version is `0.1.0`.
- [ ] Confirm About screen displays `0.1.0`.
- [ ] Confirm release notes are updated for `v0.1.0`.

## Build Verification

- [ ] Run `npm run check`.
- [ ] Run `npm run smoke`.
- [ ] Run `npm run build:tauri`.
- [ ] Confirm Windows MSI artifact exists under `src-tauri/target/release/bundle/msi/`.
- [ ] Confirm Windows NSIS artifact exists under `src-tauri/target/release/bundle/nsis/`.

## Smoke Tests

- [ ] Smoke test Build with AI.
- [ ] Smoke test iterative draft revision.
- [ ] Smoke test Guided Builder.
- [ ] Smoke test Edit with AI.
- [ ] Smoke test Guided Editor.
- [ ] Smoke test Use Prepared Prompt.
- [ ] Smoke test Use Custom Prompt.
- [ ] Smoke test provider connection.
- [ ] Smoke test Import `.agentkit.zip`.
- [ ] Smoke test Import local folder.
- [ ] Smoke test Import Git repository.
- [ ] Smoke test Package / Export `.agentkit.zip`.
- [ ] Smoke test Package / Export `.onefile.md`.
- [ ] Smoke test Install on Local Agent: Codex.
- [ ] Smoke test Install on Local Agent: Claude Code.
- [ ] Smoke test Settings save/update behavior.
- [ ] Smoke test My Kits remove behavior and confirm files are not deleted.

## Release Artifacts

Expected generated artifact locations:

- `src-tauri/target/release/bundle/msi/`
- `src-tauri/target/release/bundle/nsis/`

Expected upload names:

- `AgentKitForge-0.1.0-setup.exe`
- `AgentKitForge-0.1.0-x64.msi`
- `checksums.txt`

Suggested local rename/copy mapping:

- `src-tauri/target/release/bundle/nsis/AgentKitForge_0.1.0_x64-setup.exe` -> `AgentKitForge-0.1.0-setup.exe`
- `src-tauri/target/release/bundle/msi/AgentKitForge_0.1.0_x64_en-US.msi` -> `AgentKitForge-0.1.0-x64.msi`

## Checksums

- [ ] Generate SHA-256 checksums for release artifacts.
- [ ] Save checksums as `checksums.txt`.
- [ ] Verify checksum file includes the final upload artifact names.

Example PowerShell command after copying/renaming artifacts into a release folder:

```powershell
Get-FileHash .\AgentKitForge-0.1.0-setup.exe, .\AgentKitForge-0.1.0-x64.msi -Algorithm SHA256 |
  ForEach-Object { "$($_.Hash)  $([System.IO.Path]::GetFileName($_.Path))" } |
  Set-Content .\checksums.txt
```

## Release Publishing

- [ ] Upload release artifacts.
- [ ] Upload `checksums.txt`.
- [ ] Upload release artifacts only when ready.
- [ ] Include `RELEASE_NOTES.md` content in the release description.
- [ ] Note that code signing is not configured yet.
- [ ] Note that auto-update is not implemented yet.
- [ ] Update website download links.
- [ ] Verify website download links after publishing.

## Do Not Include in v0.1.0

- [ ] Do not publish Agent Kit Market integration claims.
- [ ] Do not publish organization/private repo sync claims.
- [ ] Do not claim code signing is configured unless it has been added.
- [ ] Do not claim auto-update is configured.
- [ ] Do not upload from this checklist step unless intentionally performing release publishing outside this repo.
