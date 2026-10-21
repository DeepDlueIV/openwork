# NoClip work checkpoint

Updated: 2026-10-22. Always reconcile this note with live GitHub state before resuming.

## SECURITY HOLD — highest priority

The user reported that the browser blocked `noclip-isolated-windows-x64-12-1.zip` with `This file contains a virus or malware.` The user allowed the download; execution was not confirmed. Do not recommend running this installer, bypassing download protection, adding antivirus exclusions, or publishing it while this warning is unresolved.

Mozilla documents this exact Firefox warning as a potentially malicious download detected through Google Safe Browsing. It is distinct from `This file is not commonly downloaded`. The unsigned build is a fact, but is NOT an established explanation for this warning. Neither maliciousness nor a false positive has been confirmed.

Reference: https://support.mozilla.org/en-US/kb/where-find-and-manage-downloaded-files-firefox

No new antivirus result is available. The local container and Python inspection attempts failed with runtime ClientError. An attempted diagnostic workflow `.github/workflows/noclip-security-audit.yml` was blocked by the tool safety checks before execution; it was not created or run. Do not claim an antivirus scan is running or clean, and do not retry through alternate mechanisms to circumvent that tool block.

Next permitted investigation: obtain an antivirus report for the exact downloaded archive/installer without executing it; record the actual detection name and affected file, and compare its SHA256 with the original CI artifact/manifest. A clean result from one scanner alone does not resolve the Safe Browsing warning. If a false positive is established, submit the relevant sample/URL through the vendor's legitimate review process. Do not promise that code signing, a different filename, or a GitHub Release eliminates all future warnings.

The earlier suggestion to install build 12 is withdrawn pending this investigation. Existing successful installation tests remain valid only for their stated scope; they are not malware/security certification. The publication work below is deferred until the hold is resolved.

## Task and branches

Deliver a separately installed Windows x64 NoClip preview, preserve user data on upgrades/reinstall, and provide a convenient download through a GitHub pre-release. Do not integrate Shluz or change product UX in this task.

- Repository: `DeepDlueIV/openwork`.
- Development branch: `noclip-install-isolation`.
- Main NoClip branch: `noclip`; isolation has not yet been merged there.
- Installer source: `c01b6c2b4268dea8e121bdde9012855a8e796571`.
- Preserved source branch: `noclip-preview-source-12-1`, at that exact SHA; do not move it.
- Recovery/reporting rules added to `AGENTS.md` in `d34dbc4bcd679c697b3ae9c8080a89cfe5027e60`.
- Latest publication implementation: `3b5e46fb5f49a7c503508895787d4dbd0e7a259f` (Git tag creation, no force-push). This changes delivery only, not installer bytes.

## Last verified build checkpoint — not security clearance

Windows build job succeeded: compilation, isolation/session tests, package verification, installation, lower-version upgrade, uninstall and reinstall with original OpenWork/profile sentinel hashes preserved:
https://github.com/DeepDlueIV/openwork/actions/runs/39620223488/job/119291401160

The overall run failed in its separate publication job. Do not confuse it with older failed build #11 or unnecessarily rebuild build #12.

- Version: `0.18.58-noclip.12.1`.
- Run: `39620223488`, attempt 1.
- Artifact: `12355531744`, `noclip-isolated-windows-x64-12-1`.
- Investigation-only artifact URL: https://github.com/DeepDlueIV/openwork/actions/runs/39620223488/artifacts/12355531744
- Artifact ZIP SHA256: `64e01c931989879ba24c1ed62a495376cb2b17d28d32973af2ef36cd62c2fc89`.
- Payload: `NoClip-Setup-x64.exe`, `SHA256SUMS.txt`, `BUILD-INFO.txt`, `INSTALL-SMOKE.json`.
- Installer unsigned; GUI launch and Shluz NOT verified. Upgrade fixture uses identical source with a lower version; database migrations NOT tested.
- Artifact availability was reconfirmed during this investigation, with expiry `2026-10-28T15:02:44Z`.

## Confirmed publication block — deferred, not running in the background

Workflow https://github.com/DeepDlueIV/openwork/actions/runs/39623215438 failed on its first and second attempts after payload verification. REST tag creation returned HTTP 403.

Creating the source-preservation branch did not resolve the restriction. A regular Git tag push was then tested in https://github.com/DeepDlueIV/openwork/actions/runs/39633959260/job/119339313514 . Archive/source/checksum/evidence verification succeeded; GitHub rejected the tag with: `Unable to determine if workflow can be created or updated due to timeout; workflows scope may be required.` No release was published. The releases collection was checked again during this investigation and was empty.

The connector can read and update files. Do not report that all GitHub writing is unavailable. Do not change repository protections, increase credential scopes, repeat equivalent publication attempts indefinitely, or treat the specific timeout/authorization error as proof of an unrestricted permissions problem.

After security clearance only: an authorized maintainer can create `noclip-v0.18.58-noclip.12.1` at exactly `c01b6c2b4268dea8e121bdde9012855a8e796571`, or securely provision an explicitly authorized release credential. Never ask for credentials in chat. Re-read tag and release state before retrying publication. Never retarget an existing tag or publish an installer under a different source SHA.

## User data and delivery rules

Close NoClip and run a newer approved installer over the installed version; no prior uninstall is required. Profile: `.noclip` under the OS account home, separate from OpenWork. Normal uninstall intentionally preserves chats/settings/credentials. Full erasure is separate and requires explicit consent. Never delete original OpenWork data or projects during recovery.

For a future cleared build, first verify a clean NoClip launch and an empty test folder without real credentials; then test the gateway separately with its approved endpoint and a limited personal gateway token. Do not claim GUI, gateway integration, other-platform installers or automatic in-app updates are complete. Upstream updates remain disabled.

Give direct links for approved downloads. A pre-release is optional for running the application, but offers a more convenient release page and direct EXE asset; it is not an antivirus guarantee.

Propose a reusable release/recovery skill only after the process is reliably repeatable. Do not create a skill now.
