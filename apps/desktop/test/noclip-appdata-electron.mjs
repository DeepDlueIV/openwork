// Disposable CI diagnostic only. No OpenWork runtime, credentials or network UI is loaded.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { applyNoClipProfile } from "../electron/noclip-profile.mjs";

const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const hostHome = process.env.NOCLIP_STARTUP_TEST_HOME;
const reportPath = process.env.NOCLIP_STARTUP_TEST_REPORT;
const inside = (target, root) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP || !hostHome || !reportPath
    || !inside(hostHome, process.env.RUNNER_TEMP) || !inside(reportPath, process.env.RUNNER_TEMP)) {
  app.exit(1);
  throw new Error("This startup fixture requires a disposable CI directory.");
}
let stage = "profile";
const timer = setTimeout(() => {
  writeFileSync(reportPath, JSON.stringify({ ok: false, stage, error: "Electron startup timeout" }));
  app.exit(1);
}, 30000);
async function run() {
  try {
    // This synchronous section executes before the module's first event-loop tick.
    // Do not prime app.getPath('appData') before changing the environment.
    const profile = applyNoClipProfile({ app, hostHome });
    const appData = app.getPath("appData");
    assert.equal(appData, profile.environment.APPDATA);
    assert.equal(app.getPath("userData"), profile.userDataPath);
    assert.equal(app.getPath("sessionData"), profile.userDataPath);
    const sentinel = path.join(profile.userDataPath, "startup-fixture.txt");
    const existed = existsSync(sentinel);
    if (existed) assert.equal(readFileSync(sentinel, "utf8"), "persist across startup");
    else writeFileSync(sentinel, "persist across startup");
    stage = "ready";
    await app.whenReady();
    stage = "window";
    const window = new BrowserWindow({ show: false, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    } });
    stage = "renderer";
    await window.loadURL("data:text/html,<title>NoClip profile smoke</title><p>Profile ready</p>");
    assert.equal(await window.webContents.executeJavaScript("document.body.textContent"), "Profile ready");
    assert.equal(window.webContents.isCrashed(), false);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({ ok: true, electron: process.versions.electron,
      appDataExplicit: true, profileIsolated: true, rendererLoaded: true,
      existingProfilePreserved: existed, fullNoClipGuiTested: false }, null, 2));
    window.destroy();
    clearTimeout(timer);
    app.exit(0);
  } catch (error) {
    clearTimeout(timer);
    writeFileSync(reportPath, JSON.stringify({ ok: false, stage, error: error.message, stack: error.stack }, null, 2));
    console.error(error);
    app.exit(1);
  }
}
// Electron waits for its ESM entry module to finish before emitting ready.
// Top-level awaiting run() here would deadlock the lifecycle being tested.
void run();
