# NoClip work checkpoint

Updated: 2026-10-21. Always reconcile this note with live GitHub state before resuming.

## Task and branches

Deliver a separately installed Windows x64 NoClip preview, preserve user data on upgrades/reinstall, and provide a direct download through a GitHub pre-release. Do not integrate Shluz or change product UX in this task.

- Repository: `DeepDlueIV/openwork`.
- Development branch: `noclip-install-isolation`.
- Main NoClip branch: `noclip`; isolation has not yet been merged there.
- Verified installer source: `c01b6c2b4268dea8e121bdde9012855a8e796571`.
- Preserved source branch: `noclip-preview-source-12-1`, created at that exact SHA; do not move it.
- Recovery/reporting rules added to `AGENTS.md` in `d34dbc4bcd679c697b3ae9c8080a89cfe5027e60`.
- Latest publication implementation: `3b5e46fb5f49a7c503508895787d4dbd0e7a259f` (Git tag creation, no force-push). This changes delivery only, not the installer payload.

## Last verified checkpoint

Windows build job **succeeded**, including compilation, isolation/session tests, package verification, installation, lower-version upgrade, uninstall and reinstall with original OpenWork/profile sentinel hashes preserved:
https://github.com/DeepDlueIV/openwork/actions/runs/39620223488/job/119291401160

The overall run failed only in its separate publication job. Do not confuse it with the older failed build #11 or rebuild the verified installer unnecessarily.

- Version: `0.18.58-noclip.12.1`.
- Run: `39620223488`, attempt 1.
- Artifact: `12355531744`, `noclip-isolated-windows-x64-12-1`.
- Artifact download: https://github.com/DeepDlueIV/openwork/actions/runs/39620223488/artifacts/12355531744
- Artifact ZIP SHA256: `64e01c931989879ba24c1ed62a495376cb2b17d28d32973af2ef36cd62c2fc89`.
- Payload: `NoClip-Setup-x64.exe`, `SHA256SUMS.txt`, `BUILD-INFO.txt`, `INSTALL-SMOKE.json`.
- Installer is unsigned. GUI launch and Shluz are NOT verified. Upgrade fixture uses identical source with a lower version; database migrations are NOT tested.

## Confirmed publication block (not an ongoing background task)

Publication workflow https://github.com/DeepDlueIV/openwork/actions/runs/39623215438 failed on its first attempt and again on attempt 2, job `119337682514`, after payload verification. REST tag creation returned HTTP 403.

The source-preservation branch did not resolve the restriction. The regular Git tag push was then checked in https://github.com/DeepDlueIV/openwork/actions/runs/39633959260/job/119339313514 . Archive/source/checksum/evidence verification succeeded; GitHub rejected the tag with: `Unable to determine if workflow can be created or updated due to timeout; workflows scope may be required.` No release was published by these runs.

The connector can update files and rerun jobs (both were verified). Do NOT report that all GitHub writing is unavailable. The remaining restriction is tag/release publication with the Actions token for this source. The loaded connector does not expose a tag/release creation action. No permissions or repository protections were changed. Do not repeat equivalent attempts indefinitely.

## Next safe action

An authorized maintainer must create the tag `noclip-v0.18.58-noclip.12.1` at EXACTLY `c01b6c2b4268dea8e121bdde9012855a8e796571` (branch `noclip-preview-source-12-1`), or explicitly provision a release credential with the appropriate repository/workflow authorization through a secure interface. Never ask for a token in chat.

Then read the tag target and release state, rerun only the publication job, and verify the resulting public release and assets. Do not move an existing tag, substitute another source SHA, merge unrelated upstream changes, or disable tests to make publication appear successful. If release creation is also denied, report that specific result and stop.

The already verified artifact remains the download fallback, with GitHub's retention period. Do not claim a durable public Releases link exists before checking it.

## User data and delivery rules

Close NoClip and run a newer installer over the installed version; no prior uninstall is required. Profile lives under the OS account home's `.noclip`, separated from OpenWork. Normal uninstall deliberately preserves chats/settings/credentials. Full erasure is separate and requires explicit consent. Do not delete profiles or original OpenWork files during recovery.

Provide direct links to the actual verified installer and release, not just repository/Actions navigation. Do not claim GUI, gateway integration, all-platform installers or automatic in-app updating are complete. Upstream updates remain disabled.

Suggest a reusable release/recovery skill only once this process is reliably repeatable; the user has not authorized creating a skill now.
