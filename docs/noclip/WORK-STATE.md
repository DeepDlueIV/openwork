# NoClip work checkpoint

Updated: 2026-10-23. Reconcile with live branches, CI attempts and artifacts before any write. No task is implicitly running between conversations.

## Current task: fix Windows first startup

The user ran installed build `0.18.58-noclip.12.1` and supplied a screenshot showing `Error: Failed to get 'appData' path`. Their local Codex report confirmed separate installations, archive/installer hashes, installed package metadata and disabled upstream updater; it did not run the GUI. Do not confuse static checks with successful startup. Do not record the user's local paths or personal files in this public repository.

- Repository: `DeepDlueIV/openwork`.
- Active fix branch: `noclip-fix-appdata`, based on `b68685bc9a6263c91cff30293cfbb85f9e26573d` from `noclip-install-isolation`.
- Previous integration branch: `noclip-install-isolation`; main NoClip branch: `noclip`.
- Actual startup fix: `f090a247473ed6788bf38bb50a88687127e3f5f7`.
- Production change: create private directories, then call `app.setPath('appData', profile.environment.APPDATA)` BEFORE redirecting HOME/USERPROFILE/APPDATA and importing upstream modules. Keep userData/sessionData/runtime isolation and disabled updates unchanged. No user data is deleted or migrated.

## Evidence already verified

1. Real Windows Electron 43.7.7 reproduced the exact `Failed to get 'appData' path` error before the fix. Three added unit regressions failed while the nine prior isolation checks passed:
   https://github.com/DeepDlueIV/openwork/actions/runs/39920760810
2. The fix made all twelve unit/isolation checks pass. The first native fixture then exposed a test-harness top-level-await/ready deadlock, not another appData failure. The fixture now allows the ESM entry module to finish before waiting for ready.
3. Corrected native fixture and fix passed real Electron cold startup, renderer creation and a second startup with its profile marker preserved; the twelve unit/isolation checks also passed:
   https://github.com/DeepDlueIV/openwork/actions/runs/39921077569
   Source: `a82637329dadea360f6ca5f252deb122b56db5f2`.
   This is a minimal native profile/renderer test, NOT the full NoClip application GUI.

## Pending full packaged verification

- Full build source: `86cf5e4075c97ee53419920ad971c3c03f5cfa02`.
- Build #14: https://github.com/DeepDlueIV/openwork/actions/runs/39921323220
- Outcome was not yet known at this checkpoint. Do not call its installer ready.
- The workflow now requires a real packaged NoClip GUI to mount beyond its static startup placeholder, creates screenshots, closes it and launches it again, and checks a profile marker before installer upgrade/uninstall/reinstall tests.
- GUI evidence is uploaded even on failure. Installer is uploaded only after all functional checks succeed. No release is published from the fix branch.

Next safe action: read build #14 jobs and GUI evidence. If it fails, inspect that exact failed stage, preserve successful work, and repair only the demonstrated issue. If it passes, verify the artifact identity/checksums, preserve a concise handoff and present direct evidence links. Do not rebuild merely to update documentation. Do not change user's local installation or original OpenWork data remotely.

## Browser-warning investigation remains separate

The earlier build-12 ZIP was blocked by Firefox with `This file contains a virus or malware`. The user subsequently reported a Windows Defender scan with no threats. This is a user-reported scan, not an independently obtained malware report or proof of a false positive. Matching hashes establishes provenance, not safety.

Do not recommend bypassing browser/antivirus protection, adding exclusions, distributing the flagged build, or disabling security checks. The known warning is unresolved. This does NOT forbid source-code fixes or functional diagnostics in disposable CI without personal files or credentials. Functional success must never be described as security clearance. `NOCLIP_RELEASE_APPROVED` is not set by this task; publication stays gated.

A previous antivirus diagnostic workflow attempt was blocked before execution; it was not run. Do not retry the blocked scan through another mechanism. Permitted investigation remains obtaining the exact detection/file and vendor review through legitimate channels. No security-clearance claim is made for the new diagnostic build.

## Historical build and publication context

- Older build #12: `0.18.58-noclip.12.1`, source `c01b6c2b4268dea8e121bdde9012855a8e796571`, run `39620223488`.
- Preserved branch: `noclip-preview-source-12-1`; do not move it.
- Artifact `12355531744`, ZIP SHA256 `64e01c931989879ba24c1ed62a495376cb2b17d28d32973af2ef36cd62c2fc89`.
- Installer SHA256 from the local report/manifest: `6436261bd00838e4fbc7f9c929ccafcba1c4c1da94483525d097200bf036e55f`.
- Build-12 installation/upgrade/uninstall tests passed, but the real user GUI failed at appData. Do not direct the user back to that installer to test this fix.
- Release publication previously failed creating its exact-source tag: REST HTTP 403, then Git error `Unable to determine if workflow can be created or updated due to timeout; workflows scope may be required.` General file-write access works. No repository protections or credential scopes were changed.
- Do not resume publication or change a tag to an unrelated commit as part of the startup bugfix.

## Data, reporting and future automation

Approved future installers update NoClip in place without prior uninstall. Profile `.noclip` under the OS account home is separate from original OpenWork; normal uninstall retains settings/history/credentials. Never erase profiles or projects to make a test pass. Full erasure requires explicit consent.

Report actual evidence: compiled, unit-tested, native-profile-tested, packaged-GUI-tested, installed, security-reviewed and published are distinct states. The user delegates local checks to Codex; do not require them to read CI logs we can inspect. Give direct links and concise results. Shluz integration and real database migrations are out of scope here.

Propose a reusable recovery/release skill only after the procedure is reliably repeatable; do not create a skill in this task.
