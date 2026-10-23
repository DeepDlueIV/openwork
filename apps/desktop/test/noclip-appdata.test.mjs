import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyNoClipProfile, resolveNoClipProfile } from "../electron/noclip-profile.mjs";

function coldElectronApp() {
  const paths = new Map();
  return {
    paths,
    setName() {},
    setAppUserModelId() {},
    setPath(name, value) {
      assert.ok(existsSync(value), `Directory must exist before app.setPath(${name})`);
      paths.set(name, value);
    },
    setAppLogsPath(value) { paths.set("logs", value); },
    getPath(name) {
      if (!paths.has(name)) throw new Error(`Failed to get '${name}' path`);
      return paths.get(name);
    },
  };
}

test("cold startup explicitly supplies Electron appData instead of resolving Windows known folders", async (t) => {
  const hostHome = await mkdtemp(path.join(tmpdir(), "noclip-appdata-"));
  t.after(() => rm(hostHome, { recursive: true, force: true, maxRetries: 5 }));
  const app = coldElectronApp();
  const env = { HOME: hostHome, USERPROFILE: hostHome, APPDATA: "unavailable-original-appdata" };
  const profile = applyNoClipProfile({ app, env, hostHome });
  assert.equal(app.getPath("appData"), profile.environment.APPDATA);
  assert.equal(app.getPath("userData"), profile.userDataPath);
  assert.equal(app.getPath("sessionData"), profile.userDataPath);
  assert.equal(env.APPDATA, app.getPath("appData"));
  assert.notEqual(app.getPath("appData"), "unavailable-original-appdata");
});

test("Electron appData is initialized before HOME, USERPROFILE or APPDATA are redirected", async (t) => {
  const hostHome = await mkdtemp(path.join(tmpdir(), "noclip-appdata-order-"));
  t.after(() => rm(hostHome, { recursive: true, force: true, maxRetries: 5 }));
  const app = coldElectronApp();
  const expected = resolveNoClipProfile({ hostHome });
  const env = new Proxy({ HOME: hostHome, USERPROFILE: hostHome }, {
    set(target, key, value) {
      if (["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].includes(key)) {
        assert.equal(app.getPath("appData"), expected.environment.APPDATA);
      }
      target[key] = value;
      return true;
    },
  });
  applyNoClipProfile({ app, env, hostHome });
});

test("a failed appData initialization leaves the inherited environment unchanged", async (t) => {
  const hostHome = await mkdtemp(path.join(tmpdir(), "noclip-appdata-failure-"));
  t.after(() => rm(hostHome, { recursive: true, force: true, maxRetries: 5 }));
  const env = { HOME: hostHome, USERPROFILE: hostHome, OPENWORK_SERVER_URL: "original" };
  const before = { ...env };
  const app = coldElectronApp();
  const setPath = app.setPath;
  app.setPath = (name, value) => {
    if (name === "appData") throw new Error("Cannot register private appData");
    setPath(name, value);
  };
  assert.throws(() => applyNoClipProfile({ app, env, hostHome }), /Cannot register private appData/);
  assert.deepEqual(env, before);
});
