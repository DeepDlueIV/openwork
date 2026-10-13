import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupLegacyDesktopIdentity } from "../electron/legacy-desktop-identity.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwork-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, "userData");
  const programsPath = path.join(root, "Programs");
  await mkdir(userDataPath);
  await mkdir(programsPath);
  return {
    userDataPath,
    programsPath,
    appName: "OpenWork",
    appIdentifier: "com.differentai.openwork",
    executablePath: path.join(root, "OpenWork.exe"),
    restoreStockShortcut: true,
  };
}

const missing = (file) => assert.rejects(access(file), { code: "ENOENT" });
const ownedShortcut = (input) => ({ target: input.executablePath, appUserModelId: input.appIdentifier });

test("removes legacy caches and shortcut, restoring only stock OpenWork identity", async (t) => {
  const input = await fixture(t);
  const legacyShortcut = path.join(input.programsPath, "Legacy desktop.lnk");
  await writeFile(legacyShortcut, "legacy");
  await writeFile(path.join(input.userDataPath, "windows-brand-shortcut.txt"), legacyShortcut);
  const caches = ["brand-icon.png", "brand-icon.json", "brand-icon.ico", "openwork-stock.ico"];
  await Promise.all(caches.map((name) => writeFile(path.join(input.userDataPath, name), "legacy")));
  const calls = [];
  await cleanupLegacyDesktopIdentity({ ...input, shell: {
    readShortcutLink: (shortcutPath) => {
      assert.equal(shortcutPath, legacyShortcut);
      return { ...ownedShortcut(input), appUserModelId: `${input.appIdentifier}.brand.0123456789abcdef` };
    },
    writeShortcutLink: (...args) => { calls.push(args); return true; },
  } });
  assert.deepEqual(calls, [[path.join(input.programsPath, "OpenWork.lnk"), "create", {
    target: input.executablePath,
    cwd: path.dirname(input.executablePath),
    description: "OpenWork",
    icon: input.executablePath,
    iconIndex: 0,
    appUserModelId: input.appIdentifier,
  }]]);
  await missing(legacyShortcut);
  for (const name of [...caches, "windows-brand-shortcut.txt"]) await missing(path.join(input.userDataPath, name));
});

test("does not delete arbitrary paths from a corrupt legacy marker", async (t) => {
  const input = await fixture(t);
  const unrelated = path.join(input.userDataPath, "keep.txt");
  await writeFile(unrelated, "keep");
  await writeFile(path.join(input.userDataPath, "windows-brand-shortcut.txt"), unrelated);
  await cleanupLegacyDesktopIdentity({ ...input, shell: {
    readShortcutLink() { assert.fail("not a Programs shortcut"); },
    writeShortcutLink() { assert.fail("not a legacy shortcut"); },
  } });
  assert.equal(await readFile(unrelated, "utf8"), "keep");
});

test("keeps the marker and old shortcut for retry if stock restoration fails", async (t) => {
  const input = await fixture(t);
  const legacyShortcut = path.join(input.programsPath, "Legacy desktop.lnk");
  const marker = path.join(input.userDataPath, "windows-brand-shortcut.txt");
  await writeFile(legacyShortcut, "legacy");
  await writeFile(marker, legacyShortcut);
  await assert.rejects(cleanupLegacyDesktopIdentity({ ...input, shell: {
    readShortcutLink: () => ownedShortcut(input),
    writeShortcutLink: () => false,
  } }), /restore/);
  assert.equal(await readFile(marker, "utf8"), legacyShortcut);
  assert.equal(await readFile(legacyShortcut, "utf8"), "legacy");
});

test("preserves unrelated shortcuts inside Programs without restoring a stock shortcut", async (t) => {
  const input = await fixture(t);
  const unrelated = path.join(input.programsPath, "Other app.lnk");
  const marker = path.join(input.userDataPath, "windows-brand-shortcut.txt");
  await writeFile(unrelated, "other app");
  const otherTarget = path.join(path.dirname(input.executablePath), "Other.exe");
  for (const details of [
    { target: otherTarget, appUserModelId: "com.example.other" },
    { target: input.executablePath, appUserModelId: "com.example.other" },
    { target: otherTarget, appUserModelId: input.appIdentifier },
    { target: input.executablePath, appUserModelId: `${input.appIdentifier}.brand.not-a-legacy-id` },
  ]) {
    await writeFile(marker, unrelated);
    await cleanupLegacyDesktopIdentity({ ...input, shell: {
      readShortcutLink: (shortcutPath) => { assert.equal(shortcutPath, unrelated); return details; },
      writeShortcutLink() { assert.fail("unrelated shortcut must not restore stock identity"); },
    } });
    assert.equal(await readFile(unrelated, "utf8"), "other app");
    await missing(marker);
  }
});

test("discards a missing shortcut marker without restoring a stock shortcut", async (t) => {
  const input = await fixture(t);
  const absent = path.join(input.programsPath, "Missing desktop.lnk");
  const marker = path.join(input.userDataPath, "windows-brand-shortcut.txt");
  await writeFile(marker, absent);
  await cleanupLegacyDesktopIdentity({ ...input, shell: {
    readShortcutLink: (shortcutPath) => {
      assert.equal(shortcutPath, absent);
      throw Object.assign(new Error("Shortcut not found"), { code: "ENOENT" });
    },
    writeShortcutLink() { assert.fail("missing shortcut must not restore stock identity"); },
  } });
  await missing(marker);
  await missing(absent);
});

test("is idempotent on a clean profile and never creates a shortcut", async (t) => {
  const input = await fixture(t);
  const shell = {
    readShortcutLink() { assert.fail("no legacy marker"); },
    writeShortcutLink() { assert.fail("no legacy marker"); },
  };
  await cleanupLegacyDesktopIdentity({ ...input, shell });
  await cleanupLegacyDesktopIdentity({ ...input, shell });
});
