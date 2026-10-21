; Deliberately do not inherit OpenWork's customUnInstall macro: it reads and
; deletes files belonging to com.differentai.openwork. electron-builder manages
; only this appId's installation, registry entry, URI scheme and shortcuts.
; NoClip's persistent profile is retained on uninstall; no user data is deleted.
!macro customUnInstall
!macroend
