# NoClip work checkpoint

Updated: 2026-10-23. Reconcile with live branches, CI attempts and artifacts before any write. A paused conversation is not a background task.

## Current task and branches

Fix build-12 Windows startup: `Error: Failed to get 'appData' path`. The local report verified metadata/hashes and disabled updater, not GUI startup; the user's subsequent screenshot demonstrates the crash. Do not publish personal local paths/files.

- Repository: `DeepDlueIV/openwork`.
- Active branch: `noclip-fix-appdata`, based on `b68685bc9a6263c91cff30293cfbb85f9e26573d`.
- Draft PR: https://github.com/DeepDlueIV/openwork/pull/1
- Integration branch: `noclip-install-isolation`; main branch: `noclip`. Fix is not merged.
- Production fix: `f090a247473ed6788bf38bb50a88687127e3f5f7`.
- Create private directories and explicitly register Electron `appData` BEFORE changing HOME/USERPROFILE/APPDATA and importing upstream modules. Preserve existing runtime/userData/sessionData isolation and disabled updater. No user data is deleted or imported.

## Confirmed regression evidence

Before the fix, real Electron 43.7.7 on Windows reproduced the exact appData error; three new regression tests failed and nine previous checks passed:
https://github.com/DeepDlueIV/openwork/actions/runs/39920760810

After the fix, real Electron cold startup, a sandboxed renderer and second startup retaining a marker passed, along with twelve unit/isolation tests:
https://github.com/DeepDlueIV/openwork/actions/runs/39921077569
Source `a82637329dadea360f6ca5f252deb122b56db5f2`. This minimal fixture is not the full application. An intermediate test-only top-level-await/ready deadlock was corrected without changing production code.

## Packaged GUI and active full build

Build #15 source `bd0493947697bbb96f1b352dfd47091889c395cc` passed compilation, twelve isolation tests, twenty-three session/journal tests, installer packaging and package metadata validation. Its actual NoClip GUI completed both launches, screenshots, clean exits and profile-marker checks. The overall GUI step then failed AFTER those checks with `EXDEV`, retaining its own newly-created profile from C: to D: RUNNER_TEMP:
https://github.com/DeepDlueIV/openwork/actions/runs/39921886686/job/120308935638
GUI evidence: https://github.com/DeepDlueIV/openwork/actions/runs/39921886686/artifacts/12487908489
Installer-lifecycle/upload were skipped; do not call #15 fully successful or available to download.

The CI-only retention destination was corrected to an absent sibling directory on the SAME volume in `9a0daee6e934c414db56ff4ce5f94bd1dfdf9676`. The test still refuses pre-existing profiles, retains its own data without uploading it, and does not disable any checks.

**Current build #16**, exact source `9a0daee6e934c414db56ff4ce5f94bd1dfdf9676`:
https://github.com/DeepDlueIV/openwork/actions/runs/39923809651
At this checkpoint it is in progress; final GUI, lifecycle and artifact outcomes are unknown. Read this run before continuing. On success inspect source/version, artifact inventory and GUI/installation evidence; on failure diagnose its exact failed step. Do not rebuild for documentation changes.

Build #14 was superseded when separating newly-created GUI profile files from subsequent installer retention fixtures. #15 exposed the cross-volume test bookkeeping issue above. Do not confuse those with current #16 or inherited Warden runs. Evidence ZIPs are not installer ZIPs. No release is published from this feature branch.

## Independent review and browser warning

Inherited Warden failed because model authentication is absent (`No API key found for openai`):
https://github.com/DeepDlueIV/openwork/actions/runs/39921893581
Do not claim independent security review, disable checks or change secrets/protections.

Firefox blocked the build-12 ZIP with `This file contains a virus or malware`. The user later reported a clean Defender scan. This is user-reported evidence, not independently established false-positive clearance. Hashes prove provenance, not safety. Do not recommend bypasses, exclusions or distributing the flagged build. Source fixes and functional diagnostics on disposable CI without personal files/keys are allowed; functional success is not security clearance. No release approval variable is set by this task.

An earlier antivirus-workflow tool call was blocked before execution and never ran; do not circumvent that block. Legitimate vendor investigation remains separate. Do not claim the new diagnostic installer has antivirus clearance.

## Historical build and publishing

- Build #12: `0.18.58-noclip.12.1`; source `c01b6c2b4268dea8e121bdde9012855a8e796571`; run `39620223488`.
- Preserved branch `noclip-preview-source-12-1`; never move it.
- Artifact `12355531744`; ZIP SHA256 `64e01c931989879ba24c1ed62a495376cb2b17d28d32973af2ef36cd62c2fc89`.
- Installer SHA256 `6436261bd00838e4fbc7f9c929ccafcba1c4c1da94483525d097200bf036e55f`.
- Installer lifecycle passed then, but real startup failed. Do not offer #12 to test this fix.
- Publishing failed creating an exact-source tag: REST 403 and Git workflows-scope/timeout error. General file-write access works. No protections/scopes were changed. Publication is outside this startup fix.

## Data, communication and recovery

Approved newer installers update NoClip in place without uninstalling first. The OS account home's `.noclip` profile is separate from OpenWork; normal uninstall retains settings/history/credentials. Never erase user profiles/projects to make tests pass. Full erasure requires explicit consent.

Distinguish compiled, unit-tested, minimal-native-tested, actual-GUI-tested, installed, security-reviewed and published. The user delegates local checks to Codex. Give concise results/direct links; investigate accessible logs ourselves. Shluz integration, real database migrations and other-platform installers remain separate.

After interruptions re-read this checkpoint, live refs, CI attempts and artifacts; unknown outcomes must be verified before retrying writes. Preserve correct work and unrelated changes. Propose a reusable recovery/release skill only after the process is reliable; no skill creation now.
