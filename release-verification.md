# P0–P2 Release Verification Evidence

Date: 2026-07-27

## Windows versioned upgrade

- v0.1.0 source/package: `package.json` version 0.1.0; artifact `dist/JOKER-0.1.0-x64.exe`.
- v0.1.0 install command used PowerShell `Start-Process` with `/S` and `/D=E:\joker\.qa\upgrade-install`; exit code 0; `JOKER.exe` and `Uninstall JOKER.exe` existed.
- v0.1.0 launch via CDP on port 9240 reported Electron app version 0.1.0 and rendered JOKER UI. QA config was visible as `QA Provider / gpt-4o`.
- v0.1.1 was built from incremented package version with `signAndEditExecutable: false` because electron-builder's local unsigned `rcedit` failed with `Fatal error: Unable to commit changes`; the resulting unsigned artifact was built successfully at `dist-v011/JOKER-0.1.1-x64.exe`.
- v0.1.1 over-install into the same directory used `/S` and `/D=E:\joker\.qa\upgrade-install`; exit code 0; `JOKER.exe` remained present.
- v0.1.1 launch via CDP on port 9241 rendered the UI and reported `QA Provider / gpt-4o`; the isolated config and session files remained under `.qa/upgrade-home-final/.joker/`.
- Evidence: `.qa/upgrade-v010-baseline.json`, `.qa/upgrade-v011-result.json`, `output/playwright/windows-upgrade-v011.png`, `dist-v011/JOKER-0.1.1-x64.exe`.

## Windows uninstall data retention

- v0.1.1's generated `Uninstall JOKER.exe` was executed with `/S` and returned exit code 0.
- Application files were removed: `APP_EXISTS=False`.
- User data remained unchanged under `.qa/upgrade-home-final/.joker/`: config and session files remained; before/after file count was 3/3.
- Independent isolated check also retained `.qa/post-uninstall-user-data-check/.joker/config.json` and `.qa/post-uninstall-user-data-check/.joker/sessions/keep-user-data-123456.json` after uninstall.
- Conclusion: this NSIS configuration removes the install directory but retains user data outside it.

## Boundary audit reports

- `npm run test:qualification:release-boundaries` writes a temporary report with Windows artifact hash, NSIS target, historical isolated installer lifecycle evidence, and explicit platform statuses. Latest audit: `D:\Temp\joker-release-boundaries-vl4psj\release-boundary-report.json`.
- The current `dist/JOKER-0.1.1-x64.exe` artifact is unsigned: Authenticode status is `NotSigned`, with no signer/thumbprint; `electron-builder.yml` sets `signAndEditExecutable: false`. This is `not-verified`, not signing evidence. Fresh artifact SHA-256: `15ea900ce265ee12c71ec11e6b92ba55338ee0ddd59d71625475dcb2b6a8d595` (109,596,593 bytes).
- macOS native install/startup/signing and Linux AppImage/deb install/startup/signing are `skip` on the Windows host because no native runner/toolchain is available.
- `npm run test:qualification:session-concurrency -- --workers=4 --rounds=30 --keep` produced `D:\Temp\joker-session-concurrency-CAhfnV\session-concurrency-report.json` with `status: pass`: 120 acknowledged appends, 120 final messages, 0 missing acknowledged IDs, valid primary/backup envelopes, and no `.tmp`/`.lock` residue. The session store now serializes per-session mutations across independent processes with an atomic lock directory. This evidence covers the exercised session mutation workload, not unrelated stores or stale full-snapshot replacement conflict semantics.
- `npm run test:qualification:mcp` now drives the real local `mcpManager` against isolated stdio fixtures and produced `D:\Temp\joker-mcp-boundary-1dIAM1\mcp-boundary-report.json`: 15 pass, 0 fail, 0 skip, 0 not-verified, 0 contract-gap. The evidence covers trust denial/grant, changed identity, server permission/full-auto boundary, initialize/call deadlines, crash state/retry cutoff, descendant cleanup, remove-after-close-error, and redacted lifecycle audit. It is credential-free and does not contact external MCP providers.


- The workflow `.github/workflows/release-qualification.yml` now defines explicit `workflow_dispatch` inputs for `enable_signed_release` and `signing_os`. Native jobs build Linux AppImage/deb and macOS DMG, set runner-local JSON report directories, and invoke the Linux qualification under `xvfb-run` while leaving the macOS job on its native display path; the signed-release contract sets a runner-local evidence directory and fails closed when required credentials are absent. These jobs must run on their corresponding native GitHub runners before hosted-runner evidence or formal signing can be reported as pass.
- `npm run test:qualification:signed-release` is now a fail-closed sign-and-verify entry point. It uses `JOKER_SIGNED_REPORT_DIR`, records artifact hashes and secret names only, and never records secret values. Windows requires Authenticode `Valid`; Linux signs and independently verifies AppImage/deb detached GPG signatures; macOS verifies codesign/Gatekeeper and, when Apple notarization credentials are supplied, submits with `xcrun notarytool --wait`, staples, and validates the ticket. No local credential environment was available, so the Windows run correctly returned `fail` for `signed.credentials.present`; this is not signing evidence.

- A real Linux native qualification was executed in an isolated Ubuntu 22.04 WSL2 Linux environment with Node v22.14.0 and Xvfb, using `npm run test:qualification:native-package -- --strict`. The final report was preserved at `.qa/native-linux-wsl-20260729/native-package-report.json`; it contains `pass: 13`, `fail: 0`, `skip: 0`, `not-verified: 0`. It covers AppImage invocation/extraction/startup, renderer/preload access, session creation and restart restoration, deb metadata, pre-existing-package protection, dpkg installation, installed executable resolution, installed-package startup/session restart, and dpkg removal. AppImage SHA-256: `f23297a440891008922754794ef54dda09139aa6e18823a08bdadf271e98a7a9`; deb SHA-256: `bcc5370ced290f4f7cc503776db07d4e535f5f4d5ab375db2f9fcad23ffc50f1`. The WSL report is real Linux-runner evidence, but it is not a GitHub Actions artifact and does not replace a hosted `ubuntu-latest` artifact check.
- The current workspace has no `.git` metadata or configured remote, and the `gh` CLI is unavailable. Therefore this session cannot dispatch or inspect a GitHub Actions run/artifact from a hosted native runner. A real Linux native run is now preserved locally under `.qa/native-linux-wsl-20260729/`; no local macOS runtime or formal signing credentials are available, so macOS native and formal signing remain unverified.
- A local Windows fail-closed check of `npm run test:qualification:native-package -- --strict` returned exit code 1 with `pass: 0`, `fail: 0`, `skip: 2`, `not-verified: 1`; this confirms the guard rejects the current Windows host. Separately, the Linux WSL2 native run returned exit code 0 with `pass: 13`, `fail: 0`, `skip: 0`, `not-verified: 0`. `npm run test:qualification:signed-release` likewise returned exit code 1 with `signed.credentials.present=fail` and `secretValuesLogged=false`; no sign+verify evidence exists locally.
- No `.dmg` artifact or formal signing evidence exists locally. Linux AppImage/deb artifacts used by the WSL qualification are preserved under `.qa/native-linux-wsl-20260729/`.
- CI workflow `.github/workflows/ci.yml` has Ubuntu and Windows jobs, but only runs deterministic tests and Electron bundle build; it does not package or launch macOS/Linux artifacts.
- Therefore Linux native packaging/startup/install/restart/uninstall has real isolated-runner evidence; macOS native packaging and formal signing remain explicitly unverified and require the corresponding native runner and credentials.

## Remaining release caveats

- v0.1.1 was intentionally built unsigned with `signAndEditExecutable: false`; no code-signing credentials are present.
- The original default packaging configuration can fail on this machine during unsigned executable resource editing; the versioned validation used the explicit unsigned override.
- Windows installation, upgrade, UI launch, data migration, and uninstall retention have real evidence. macOS/Linux startup requires a corresponding native runner or a functioning Linux VM/CI job.
