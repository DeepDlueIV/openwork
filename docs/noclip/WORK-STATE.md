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

## Last verified checkpoint

Windows build job **succeeded**, including compilation, isolation/session tests, package verification, installation, lower-version upgrade, uninstall and reinstall with original OpenWork/profile sentinel hashes preserved:
https://github.com/DeepDlueIV/openwork/actions/runs/39620223488/job/119291401160

The overall run failed only in its separate publication job. Do not confuse it with the older failed build #11 or rebuild the verified installer unnecessarily.

- Version: `0.18.58-noclip.12.1`.
- Run: `39620223488`, attempt 1.
- Artifact: `12355531744`, `noclip-isolated-windows-x64-12-1`.
- Artifact ZIP SHA256: `64e01c931989879ba24c1ed62a495376cb2b17d28d32973af2ef36cd62c2fc89`.
- Payload: `NoClip-Setup-x64.exe`, `SHA256SUMS.txt`, `BUILD-INFO.txt`, `INSTALL-SMOKE.json`.
- Installer is unsigned. GUI launch and Shluz are NOT verified. Upgrade fixture uses identical source with a lower version; database migrations are NOT tested.

## Interrupted/blocked stage and current action

Publication workflow: https://github.com/DeepDlueIV/openwork/actions/runs/39623215438
Its first attempt verified the archive, installer checksum and installation evidence, then received HTTP 403 creating the exact-source tag. No releases existed at the recovery check.

A source-preservation branch was created at the verified source SHA, then only the failed publication job `119301750422` was requested to rerun. The rerun request was accepted; its outcome must still be checked. Do not treat a request acknowledgement as successful publication.

Next safe action: inspect the latest attempt of run `39623215438`, then verify any release's tag SHA, uploaded assets and checksum. If denied again, inspect the specific permission failure without changing protections or silently increasing scopes. Never publish under a tag that identifies different source code.

## User data and delivery rules

Close NoClip and run a newer installer over the installed version; no prior uninstall is required. Profile lives under the OS account home's `.noclip`, separated from OpenWork. Normal uninstall deliberately preserves chats/settings/credentials. Full erasure is separate and requires explicit consent. Do not delete profiles or original OpenWork files during recovery.

Provide direct links to the actual verified installer and release, not just repository/Actions navigation. Do not claim GUI, gateway integration, all-platform installers or automatic in-app updating are complete. Upstream updates remain disabled.

Suggest a reusable release/recovery skill only once this process is reliably repeatable; the user has not authorized creating a skill now.
