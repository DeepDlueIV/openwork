import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveDesktopDistribution } from "../electron/desktop-distribution.mjs";
import { resolveNoClipProfile, applyNoClipProfile, NOCLIP_APP_ID } from "../electron/noclip-profile.mjs";
import { registerNoClipUpdaterIpc } from "../electron/noclip-updater.mjs";
import { globalOpencodeConfigDir, legacyDesktopBootstrapPath, openworkServerConfigPath,
  openworkServerDataDir, opencodeDataDirs, opencodeCacheDirs } from "../../../packages/paths/index.mjs";

function fakeApp() {
  const paths = new Map();
  return { paths, getVersion: () => "0.18.58-noclip.5.1",
    setName(value) { this.name = value; },
    setAppUserModelId(value) { this.appId = value; },
    setPath(key, value) { paths.set(key, value); },
    setAppLogsPath(value) { paths.set("logs", value); },
  };
}
function assertInside(candidate, root, paths) {
  const relative = paths.relative(root, candidate);
  assert.ok(relative === "" || (!relative.startsWith("..") && !paths.isAbsolute(relative)), candidate);
}

test("packaged NoClip has its own app identity and URI scheme", () => {
  const actual = resolveDesktopDistribution({ isPackaged: true, packageFlavor: "noclip", environmentFlavor: "public" });
  assert.equal(actual.appName, "NoClip");
  assert.equal(actual.appIdentifier, NOCLIP_APP_ID);
  assert.equal(actual.protocolScheme, "noclip");
  assert.equal(actual.flavor, "public");
  assert.equal(actual.requireActivation, false);
});

test("upstream distributions retain their identities and activation gates", () => {
  for (const flavor of ["public", "cloud", "enterprise"]) {
    const actual = resolveDesktopDistribution({ isPackaged: true, packageFlavor: flavor, environmentFlavor: "noclip" });
    assert.equal(actual.appIdentifier, "com.differentai.openwork");
    assert.equal(actual.protocolScheme, "openwork");
    assert.equal(actual.requireActivation, flavor === "enterprise");
  }
});

for (const platform of ["win32", "darwin", "linux"]) {
  test(`${platform}: engine storage and legacy fallback paths stay inside NoClip`, () => {
    const paths = platform === "win32" ? path.win32 : path.posix;
    const hostHome = platform === "win32" ? "C:\\Users\\Fixture" : "/home/fixture";
    const profile = resolveNoClipProfile({ hostHome, platform });
    const opts = { env: profile.environment, platform, homeDir: profile.homePath };
    const targets = [profile.userDataPath, ...profile.directories,
      globalOpencodeConfigDir(opts), legacyDesktopBootstrapPath(opts),
      openworkServerConfigPath(opts), openworkServerDataDir(opts),
      ...opencodeDataDirs(opts), ...opencodeCacheDirs(opts)];
    for (const target of targets) assertInside(target, profile.rootPath, paths);
    for (const [key, target] of Object.entries(profile.environment)) {
      if (["OPENWORK_ELECTRON_APP_IDENTIFIER", "OPENWORK_DESKTOP_DISTRIBUTION"].includes(key)) continue;
      assertInside(target, profile.rootPath, paths);
    }
  });
}

test("profile setup discards inherited upstream overrides and does not alter existing files", async (t) => {
  const hostHome = await mkdtemp(path.join(tmpdir(), "noclip-isolation-"));
  t.after(() => rm(hostHome, { recursive: true, force: true, maxRetries: 5 }));
  const original = path.join(hostHome, "original-openwork.json");
  await writeFile(original, "original settings");
  const env = { HOME: hostHome, USERPROFILE: hostHome, PATH: "keep-tools-path",
    OPENWORK_SERVER_CONFIG: original, OPENWORK_RUNTIME_DB: original,
    OPENWORK_ELECTRON_USERDATA: hostHome, OPENWORK_SERVER_URL: "http://original.invalid",
    OPENCODE_CONFIG: original, OPENCODE_CONFIG_CONTENT: "original", OPENWORK_DEV_MODE: "1" };
  const app = fakeApp();
  const first = applyNoClipProfile({ app, env, hostHome });
  assert.equal(app.name, "NoClip");
  assert.equal(app.appId, NOCLIP_APP_ID);
  assert.equal(app.paths.get("sessionData"), first.userDataPath);
  assert.equal(env.PATH, "keep-tools-path");
  assert.equal(env.OPENWORK_SERVER_URL, undefined);
  assert.equal(env.OPENCODE_CONFIG, undefined);
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(env.OPENWORK_DEV_MODE, undefined);
  for (const target of app.paths.values()) assertInside(target, first.rootPath, path);
  const second = applyNoClipProfile({ app, env, hostHome });
  assert.equal(second.rootPath, first.rootPath);
  assert.equal(second.userDataPath, first.userDataPath);
  assert.equal(await readFile(original, "utf8"), "original settings");
});

test("relative account homes are rejected before creating a profile", () => {
  assert.throws(() => resolveNoClipProfile({ hostHome: "../original", platform: "linux" }), /absolute/);
  assert.throws(() => resolveNoClipProfile({ hostHome: "C:original", platform: "win32" }), /absolute/);
});

test("every upstream update/recovery IPC is covered without loading an updater", async () => {
  const handlers = new Map();
  const ipcMain = { handle(channel, handler) { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); } };
  const fail = () => assert.fail("An updater, installer or network operation must not be invoked");
  const service = registerNoClipUpdaterIpc({ app: fakeApp(), ipcMain, loadAutoUpdater: fail,
    shell: { openPath: fail }, electronNet: { fetch: fail } });
  const source = await readFile(new URL("../electron/updater-upstream.mjs", import.meta.url), "utf8");
  const upstreamChannels = [...source.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual([...handlers.keys()].sort(), upstreamChannels);
  assert.equal(await service.ensureAutoUpdater(), null);
  const check = await handlers.get("openwork:updater:check")(null, "alpha", "99.0.0");
  assert.equal(check.available, false);
  assert.equal(check.feedUrl, "");
  assert.equal(check.disabled, true);
  for (const channel of ["openwork:updater:setChannel", "openwork:updater:download",
    "openwork:updater:installAndRestart", "openwork:recovery:use", "openwork:recovery:restorePrevious"]) {
    assert.equal((await handlers.get(channel)(null, "99.0.0")).ok, false);
  }
  assert.deepEqual((await handlers.get("openwork:recovery:list")(null, { versions: ["99.0.0"] })).releases, []);
  assert.equal((await handlers.get("openwork:recovery:evalSnapshot")()).quitRequested, false);
});

test("NoClip packaging does not reuse upstream installer identity, cleanup or publishing", async () => {
  const config = await readFile(new URL("../electron-builder.noclip.yml", import.meta.url), "utf8");
  assert.match(config, /^appId: io\.github\.deepdlueiv\.noclip$/m);
  assert.match(config, /^productName: NoClip$/m);
  assert.match(config, /^publish: null$/m);
  assert.match(config, /main: electron\/noclip-main\.mjs/);
  assert.match(config, /openworkDistribution: noclip/);
  assert.match(config, /include: build\/noclip-installer\.nsh/);
  assert.match(config, /deleteAppDataOnUninstall: false/);
  assert.match(config, /runAfterFinish: false/);
  const cleanup = await readFile(new URL("../build/noclip-installer.nsh", import.meta.url), "utf8");
  const instructions = cleanup.split(/\r?\n/).filter((line) => !line.trim().startsWith(";")).join("\n");
  assert.doesNotMatch(instructions, /FileOpen|Delete|RMDir|com\.differentai/);
});
