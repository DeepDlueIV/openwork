# NoClip work checkpoint

Updated: 2026-10-23. Reconcile with live branches, CI attempts and artifacts before any write. No task is implicitly running between conversations.

## Current task: fix Windows first startup

The user ran build `0.18.58-noclip.12.1` and supplied `Error: Failed to get 'appData' path`. Their local report confirmed separate installations, archive/installer hashes, package metadata and disabled upstream updater; that report did not run the GUI. Do not confuse static checks with startup. Do not publish personal machine paths or files in this public repository.

- Repository: `DeepDlueIV/openwork`.
- Active branch: `noclip-fix-appdata`, based on `b68685bc9a6263c91cff30293cfbb85f9e26573d` from `noclip-install-isolation`.
- PR: https://github.com/DeepDlueIV/openwork/pull/1 (draft; not merged).
- Previous integration branch: `noclip-install-isolation`; main NoClip branch: `noclip`.
- Production fix: `f090a247473ed6788bf38bb50a88687127e3f5f7`.
- Create private directories, then call `app.setPath('appData', profile.environment.APPDATA)` BEFORE redirecting HOME/USERPROFILE/APPDATA and importing upstream modules. userData/sessionData/runtime isolation and disabled updates remain unchanged. No user data is deleted or migrated.

## Verified red/green evidence

1. Real Electron 43.7.7 on Windows reproduced the exact appData error BEFORE the fix. The three added regression tests failed while nine previous isolation checks passed:
   https://github.com/DeepDlueIV/openwork/actions/runs/39920760810
2. After the production fix, all twelve unit/isolation tests passed. The native fixture then exposed its own top-level-await/ready deadlock; the fixture was corrected to let its ESM entry evaluation complete before waiting for ready.
3. The corrected fixture passed real Electron cold startup, a sandboxed renderer and a second startup preserving its profile marker, along with all twelve unit/isolation tests:
   https://github.com/DeepDlueIV/openwork/actions/runs/39921077569
   Source: `a82637329dadea360f6ca5f252deb122b56db5f2`.
   This is a minimal native profile/renderer test, not the full NoClip GUI.

## Full application build: current checkpoint

- Active full build is **#15**, not #14:
  https://github.com/DeepDlueIV/openwork/actions/runs/39921886686
- Job: `120308935638`, `windows-x64`.
- Exact build source: `bd0493947697bbb96f1b352dfd47091889c395cc`.
- At this checkpoint, dependencies, compilation and session-runner tests succeeded. Installer packaging is in progress; full GUI and installer-lifecycle outcomes are NOT yet confirmed. No new installer may be described as ready yet.
- Build #14 (`39921323220`) was superseded after correcting an integration issue in the test harness: the real GUI creates profile files which the subsequent installer-retention test needs to create as separate fixtures. The GUI test now preserves only its own newly-created CI profile by moving it to a fresh runner-temp directory after two successful launches. It does not delete or upload that profile.
- The full pipeline must load the actual packaged renderer beyond its static startup placeholder, capture screenshots, close it, launch it again and preserve a profile marker. It then executes install/upgrade/uninstall/reinstall retention checks. Installer artifacts are produced only after those gates pass.
- GUI JSON/screenshots/redacted logs are uploaded even on failure under `noclip-gui-evidence-15-1`. Do not assume the installer artifact exists just because the evidence artifact exists.

Next safe action: inspect build #15 jobs and any GUI evidence. Diagnose the exact failed stage before further edits; do not rerun or rebuild unchanged successful stages needlessly. After success verify installer artifact/version/source and update this checkpoint and PR. Keep links tied to their actual source SHA. Do not alter the user's local installation or original OpenWork data remotely.

## Separate inherited PR review status

The inherited Warden workflow failed at its reporting stage because its model authentication is not configured (`No API key found for openai`). It did not perform a successful security review:
https://github.com/DeepDlueIV/openwork/actions/runs/39921893581

Do not mistake Warden for the Windows installer build, claim an independent review passed, disable its checks, or change secrets/protections as part of this startup fix.

## Browser warning remains separate

Firefox previously blocked the build-12 ZIP with `This file contains a virus or malware`. The user later reported a Windows Defender scan with no threats. That is user-reported evidence, not an independently verified false positive. Matching hashes establishes provenance, not safety.

Do not recommend protection bypasses, exclusions or distributing the flagged build. The warning is unresolved. This does not prohibit source fixes and functional diagnostics on disposable CI without personal files/credentials. Functional success is not security clearance. No release approval variable is set by this task; no release is published from this branch.

A previous antivirus diagnostic workflow attempt was blocked before execution and was not run. Do not retry that blocked scan through another mechanism. Permitted investigation remains the exact detection/file and legitimate vendor review. Do not claim the new diagnostic installer has antivirus clearance.

## Historical build/publication references

- Build #12: `0.18.58-noclip.12.1`, source `c01b6c2b4268dea8e121bdde9012855a8e796571`, run `39620223488`.
- Preserved source branch `noclip-preview-source-12-1`; do not move.
- Artifact `12355531744`, ZIP SHA256 `64e01c931989879ba24c1ed62a495376cb2b17d28d32973af2ef36cd62c2fc89`.
- Installer SHA256 `6436261bd00838e4fbc7f9c929ccafcba1c4c1da94483525d097200bf036e55f`.
- Its installer lifecycle tests passed, but the user's GUI failed at appData. Do not offer the old installer to test this fix.
- Release publication failed creating the exact-source tag: REST HTTP 403, then Git error `Unable to determine if workflow can be created or updated due to timeout; workflows scope may be required.` General file-write access works. No repository protections/scopes were changed. Publication is out of scope for this startup fix.

## Delivery and continuity

Approved newer installers update NoClip in place without prior uninstall. The OS account home's `.noclip` is separate from original OpenWork; normal uninstall retains settings/history/credentials. Never erase profiles/projects to make checks pass. Full erasure requires explicit consent.

Distinguish compiled, unit-tested, native-profile-tested, packaged-GUI-tested, installed, security-reviewed and published. The user delegates local tests to Codex; do not ask them to inspect accessible CI logs. Give concise results and direct links. Shluz integration, real database migrations and other platform installers remain separate work.

Propose a reusable recovery/release skill only once the process is reliably repeatable. Do not create a skill in this task.
