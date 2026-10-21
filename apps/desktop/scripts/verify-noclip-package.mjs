import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { extractFile } = require("@electron/asar");
const output = path.resolve("apps/desktop/dist-electron");
const archive = path.join(output, "win-unpacked/resources/app.asar");
const metadata = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
assert.equal(metadata.name, "noclip-desktop");
assert.equal(metadata.productName, "NoClip");
assert.equal(metadata.desktopName, "io.github.deepdlueiv.noclip");
assert.equal(metadata.openworkDistribution, "noclip");
assert.equal(metadata.main, "electron/noclip-main.mjs");
const effective = JSON.parse(await readFile(path.join(output, "win-unpacked/noclip-build-config.json"), "utf8"));
assert.equal(effective.appId, metadata.desktopName);
assert.equal(effective.productName, "NoClip");
assert.ok(effective.publish == null || (Array.isArray(effective.publish) && effective.publish.length === 0));
assert.equal(effective.nsis.include, "build/noclip-installer.nsh");
assert.equal(effective.nsis.deleteAppDataOnUninstall, false);
assert.deepEqual(effective.protocols.flatMap((entry) => entry.schemes), ["noclip"]);

const root = await mkdtemp(path.join(tmpdir(), "noclip-package-check-"));
try {
  await mkdir(path.join(root, "electron"));
  await writeFile(path.join(root, "package.json"), JSON.stringify(metadata));
  for (const name of ["updater.mjs", "updater-upstream.mjs", "noclip-updater.mjs", "recovery.mjs", "noclip-profile.mjs"]) {
    await writeFile(path.join(root, "electron", name), extractFile(archive, `electron/${name}`));
  }
  const { registerUpdaterIpc } = await import(pathToFileURL(path.join(root, "electron/updater.mjs")).href);
  const handlers = new Map();
  const fail = () => assert.fail("Packaged NoClip attempted an upstream updater operation");
  const service = registerUpdaterIpc({ app: { isPackaged: true, getVersion: () => metadata.version },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    loadAutoUpdater: fail, electronNet: { fetch: fail }, shell: { openPath: fail } });
  assert.equal(await service.ensureAutoUpdater(), null);
  assert.equal((await handlers.get("openwork:updater:check")()).disabled, true);
  assert.equal((await handlers.get("openwork:recovery:use")(null, "99.0.0")).ok, false);
  const { applyNoClipProfile } = await import(pathToFileURL(path.join(root, "electron/noclip-profile.mjs")).href);
  const savedPaths = new Map();
  const env = { OPENWORK_ELECTRON_USERDATA: path.join(root, "original"), HOME: path.join(root, "original") };
  const app = { setName() {}, setAppUserModelId() {}, setPath: (key, value) => savedPaths.set(key, value), setAppLogsPath: (value) => savedPaths.set("logs", value) };
  const profile = applyNoClipProfile({ app, env, hostHome: root });
  assert.equal(savedPaths.get("userData"), path.join(root, ".noclip", "desktop"));
  assert.equal(applyNoClipProfile({ app, env, hostHome: root }).rootPath, profile.rootPath);
  console.log(JSON.stringify({ ok: true, version: metadata.version, appId: metadata.desktopName,
    entryPoint: metadata.main, upstreamUpdater: "disabled", installerCleanup: "NoClip only" }));
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
