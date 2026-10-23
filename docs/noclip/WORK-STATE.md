# NoClip work checkpoint

Updated: 2026-10-23. Reconcile live branches, CI attempts and artifact metadata before any write. A paused conversation is not a background task.

## Result: appData startup exception fixed; diagnostic installer built

The user reported `Error: Failed to get 'appData' path` in build 12. The same exception was reproduced in real Windows Electron and eliminated by explicitly registering the private Electron appData directory BEFORE redirecting HOME/USERPROFILE/APPDATA and importing upstream modules. Existing profile separation and disabled upstream updates remain unchanged. No user data was deleted or imported.

- Repository: `DeepDlueIV/openwork`.
- Active branch: `noclip-fix-appdata`.
- Draft PR: https://github.com/DeepDlueIV/openwork/pull/1
- Base integration branch: `noclip-install-isolation`; main NoClip branch: `noclip`. The fix has not been merged into either.
- Production fix commit: `f090a247473ed6788bf38bb50a88687127e3f5f7`.
- Successful build source: `9a0daee6e934c414db56ff4ce5f94bd1dfdf9676`.

## Latest verified installer

Build #16, version `0.18.58-noclip.16.1`:
https://github.com/DeepDlueIV/openwork/actions/runs/39923809651
Windows job `120315180943` completed successfully, including compilation, twelve isolation/appData regressions, twenty-three session/journal tests, packaging, renderer startup/restart smoke checks and installer upgrade/uninstall/reinstall retention checks. Publication was deliberately skipped; no GitHub Release was created.

Installer artifact, freshly confirmed after completion:
https://github.com/DeepDlueIV/openwork/actions/runs/39923809651/artifacts/12489147010

- ID: `12489147010`.
- Name: `noclip-isolated-windows-x64-16-1`.
- ZIP bytes: `374768435`.
- ZIP SHA256: `3aac045e385553838bd709a1f8ff5f27242111149c0c25c86d4125a2568d5fcf`.
- Expires: `2026-10-30T08:32:59Z`.
- Contents: `NoClip-Setup-x64.exe`, `SHA256SUMS.txt`, `BUILD-INFO.txt`, `INSTALL-SMOKE.json`, `GUI-SMOKE.json`.
- The ZIP digest is not the EXE digest. Read SHA256SUMS.txt before making an EXE hash claim.

GUI evidence (not an installer):
https://github.com/DeepDlueIV/openwork/actions/runs/39923809651/artifacts/12489042359

### Precise scope of the passing GUI smoke test

The packaged application creates its renderer, the React root replaces the static recovery placeholder, the process exits cleanly, and a second launch preserves the private profile marker. The test accepts startup-screen text such as `Starting up...`; it does NOT require the onboarding/workspace/chat screen to become usable. Therefore it proves the reported appData exception is resolved and initial renderer/restart behavior works, NOT complete GUI readiness. Screenshots were captured by CI but not visually inspected in this session. The local container was unavailable.

Installer lifecycle checks preserved five original-OpenWork sentinel files and four NoClip profile fixtures. The lower-version installer uses the same source with an older version string; this is not a real database-migration test. The packaged renderer was tested before installation; the installer smoke's guiLaunchTested=false describes its own narrower scope.

## Regression and diagnostic history

- Exact original error plus three failing new regression tests: https://github.com/DeepDlueIV/openwork/actions/runs/39920760810
- Fixed minimal real-Electron cold startup, renderer and restart plus twelve passing tests: https://github.com/DeepDlueIV/openwork/actions/runs/39921077569
- Build #14 was superseded to separate GUI-created profile files from installer fixtures.
- Build #15 completed both initial renderer launches but failed in CI-only profile retention with EXDEV (C: home to D: RUNNER_TEMP). Retention now uses an absent sibling on the same volume and preserves, rather than deletes or uploads, the test profile. Build #16 validates that correction and all remaining functional gates. No test was disabled.

## Next step, not a running task

Do not rebuild this installer merely for documentation edits. For continued local investigation use source/build 16, never build 12. After appropriate security clearance, local Codex should verify progress beyond the startup screen to a usable initial/workspace screen, folder selection and another restart. Gateway integration remains separate and untested. Preserve any existing .noclip profile; do not erase it to make a check pass. Reconcile actual installation version before applying a newer installer.

## Security and independent review remain separate

Firefox previously blocked the build-12 ZIP with `This file contains a virus or malware`. The user reported a clean Windows Defender scan; this is not independently established false-positive clearance. Matching hashes proves provenance, not safety. The new build is unsigned and has no antivirus/security clearance from this task. Do not recommend browser/antivirus bypasses or exclusions. Functional diagnostics were performed only in disposable CI without personal files or credentials. No release-approval variable was set and no public release published.

An earlier antivirus-workflow tool call was blocked before execution; it never ran. Do not circumvent that block. Legitimate vendor investigation remains separate. Inherited Warden could not perform review because provider authentication is absent (`No API key found for openai`): https://github.com/DeepDlueIV/openwork/actions/runs/39921893581 . Do not claim independent security review, disable checks, change secrets or repository protections.

## Historical build/publication references

- Old build #12: `0.18.58-noclip.12.1`, source `c01b6c2b4268dea8e121bdde9012855a8e796571`, run `39620223488`, artifact `12355531744`.
- Preserved source branch `noclip-preview-source-12-1`; never move it.
- Old ZIP SHA256 `64e01c931989879ba24c1ed62a495376cb2b17d28d32973af2ef36cd62c2fc89`; old installer SHA256 `6436261bd00838e4fbc7f9c929ccafcba1c4c1da94483525d097200bf036e55f`.
- Build 12 passed installer tests but failed real user startup; do not offer it for retesting this fix.
- Earlier publication failed creating an exact-source tag: REST 403 and Git workflows-scope/timeout error. General file-write access works. No protections or credential scopes were changed. Publication was outside this startup-fix task.

## Continuity and data rules

Approved newer installers update NoClip in place without first uninstalling it; the OS account home's .noclip profile is retained and separate from OpenWork. Normal uninstall retains settings/history/credentials. Full erasure requires explicit consent. Never publish personal machine paths, credentials or documents from local reports.

After interruptions verify live refs, latest CI attempts and artifact identities rather than trusting chat labels. Preserve valid and unrelated work. Distinguish compiled, initial-renderer-tested, usable-GUI-tested, installed, security-reviewed and published. Give concise results with direct links and investigate accessible logs ourselves. The user delegates local checks to Codex. Propose a reusable release/recovery skill only after the process is reliable; no skill creation now.
