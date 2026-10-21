export const NOCLIP_UPDATE_REASON = "Updates and recovery downloads are disabled in this NoClip test build.";

// Preserve the existing renderer IPC contract, but never initialize an updater,
// read an upstream feed, open a recovery installer or install anything on quit.
export function registerNoClipUpdaterIpc({ app, ipcMain }) {
  const state = () => ({ channel: "stable", feedUrl: "", currentVersion: app.getVersion(), disabled: true });
  const blocked = () => ({ ok: false, reason: NOCLIP_UPDATE_REASON });
  ipcMain.handle("openwork:updater:getChannel", async () => state());
  ipcMain.handle("openwork:updater:setChannel", async () => ({ ...state(), ...blocked() }));
  ipcMain.handle("openwork:updater:check", async () => ({
    ...state(), available: false, latestVersion: null, totalBytes: null,
    stagedVersion: null, reason: NOCLIP_UPDATE_REASON,
  }));
  ipcMain.handle("openwork:updater:download", async () => blocked());
  ipcMain.handle("openwork:updater:installAndRestart", async () => blocked());
  ipcMain.handle("openwork:recovery:recordHealthy", async () => blocked());
  ipcMain.handle("openwork:recovery:list", async () => ({ ...blocked(), releases: [] }));
  ipcMain.handle("openwork:recovery:use", async () => blocked());
  ipcMain.handle("openwork:recovery:restorePrevious", async () => blocked());
  ipcMain.handle("openwork:recovery:evalSnapshot", async () => ({
    candidates: [], releases: [], installRequests: [], openedArtifactUrls: [], quitRequested: false,
  }));
  return { ensureAutoUpdater: async () => null };
}
