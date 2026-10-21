# NoClip installation isolation

NoClip is packaged with `apps/desktop/electron-builder.noclip.yml`. The upstream
builder configurations remain unchanged. Do not install the earlier **baseline**
artifact on a personal OpenWork installation: it still has OpenWork's identity.

## Boundaries

- Application/installer identity: `io.github.deepdlueiv.noclip`; name and Windows
  shortcut: `NoClip`; URI protocol: `noclip://`, not `openwork://`.
- Persistent profile: `.noclip` inside the OS account's home directory. Electron
  data, cookies and browser storage live in `.noclip/desktop`. Engine databases,
  configuration, credentials and caches live under `.noclip/runtime`.
- The dedicated entry point establishes the profile before loading upstream
  modules. Runtime HOME/USERPROFILE are private, so legacy fallback paths cannot
  import the original OpenWork/OpenCode settings. Existing SSH keys, shell
  profiles and global agent settings are not automatically imported. User-selected
  projects remain accessible; this is application separation, not an OS sandbox.
- The OS account home (not inherited HOME/USERPROFILE) anchors the profile, so
  relaunches and updates do not nest or move it. Inherited OPENWORK_/OPENCODE_
  overrides are discarded before setting the private environment.
- Upstream updater and recovery IPC return an explicit disabled result. Neither
  a channel selection nor a recovery request can load electron-updater. No update
  feed is published. A dedicated signed NoClip updater is a later task.
- The NoClip uninstaller does not execute the upstream custom cleanup hook and
  retains the profile. It must not delete original OpenWork files or shortcuts.

This step does not replace all UI branding, integrate Shluz, remove every hosted
OpenWork feature, or certify the whole desktop. Existing icons are retained.
Only Windows is packaged here; cross-platform isolation tests do not prove macOS
or Linux installer behavior. The installer is unsigned and is not a public release.
