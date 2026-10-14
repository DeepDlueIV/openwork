import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceStore } from "../../desktop/electron/workspace-store.mjs";
import * as desktop from "../src/app/lib/desktop";
import {
  initializeDenBootstrapConfig,
  readDenBootstrapConfig,
  readDenSettings,
  refreshDenBootstrapConfigFromShell,
  setDenBootstrapConfig,
  writeDenSettings,
} from "../src/app/lib/den";
import { exchangeHandoffAndSignIn } from "../src/app/lib/den-handoff";

const target = { baseUrl: "https://den.example.test", apiBaseUrl: "https://api.example.test" };
const other = { baseUrl: "https://other.example.test", apiBaseUrl: "https://other-api.example.test" };
const branding = {
  brandAppName: " Original workspace ",
  brandLogoUrl: "https://private.example.test/logo.svg?retained=1",
  brandIconUrl: "https://private.example.test/icon.png?retained=1",
};
let root: string;
let bootstrapPath: string;
let previousOverride: string | undefined;
let receipt: string | undefined;
let writes: Array<Record<string, unknown>>;

beforeEach(async () => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
  const scratchRoot = path.join(os.tmpdir(), "opencode");
  await mkdir(scratchRoot, { recursive: true });
  root = await mkdtemp(path.join(scratchRoot, "dormant-bootstrap-"));
  bootstrapPath = path.join(root, "desktop-bootstrap.json");
  previousOverride = process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = bootstrapPath;
  writes = [];
  await writeFile(bootstrapPath, JSON.stringify({ ...target, ...branding, requireSignin: true }));
  const store = createWorkspaceStore({
    app: { getPath: () => root },
    defaultDenBaseUrl: target.baseUrl,
    defaultRequireSignin: false,
    forceRequireSignin: false,
  });
  const initial = await store.getDesktopBootstrapConfig();
  receipt = initial.rollbackSnapshotId;
  window.localStorage.setItem("openwork.den.activeOrgId", "org-a");
  Reflect.set(window, "__OPENWORK_ELECTRON__", {
    meta: { desktopBootstrap: initial },
    invokeDesktop: async (command: string, ...args: unknown[]) => {
      if (command === "getDesktopBootstrapConfig") return store.getDesktopBootstrapConfig();
      if (command === "setDesktopBootstrapConfig") {
        const next = args[0];
        if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("Expected bootstrap input");
        writes.push(Object.fromEntries(Object.entries(next)));
        return store.setDesktopBootstrapConfig(next);
      }
      if (command === "__fetch") {
        const url = String(args[0]);
        const payload = url.endsWith("/api/runtime-config")
          ? { denApiUrl: url.startsWith(other.baseUrl) ? other.apiBaseUrl : target.apiBaseUrl }
          : { token: "new-session", organization: { id: "org-a", slug: "org-a", name: "Workspace" }, connectEnabled: false };
        return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
      }
      throw new Error(`Unexpected desktop command: ${command}`);
    },
  });
  await initializeDenBootstrapConfig();
});

afterEach(async () => {
  if (previousOverride === undefined) delete process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  else process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = previousOverride;
  await rm(root, { recursive: true, force: true });
  await GlobalRegistrator.unregister();
});

async function diskBootstrap() {
  return JSON.parse(await readFile(bootstrapPath, "utf8"));
}

test("real shell getter, renderer normalization and refresh retain receipt and same-origin originals", async () => {
  expect(receipt).toBeString();
  expect(readDenBootstrapConfig().rollbackSnapshotId).toBe(receipt);
  await refreshDenBootstrapConfigFromShell();
  expect(readDenBootstrapConfig().rollbackSnapshotId).toBe(receipt);
  await setDenBootstrapConfig({ ...target, requireSignin: false, brandAppName: "Ignored input" });
  expect(await diskBootstrap()).toMatchObject({ ...branding, requireSignin: false });
  expect(readDenBootstrapConfig().rollbackSnapshotId).toBeString();
  expect(writes[0]).not.toHaveProperty("restoreSnapshotId");
  expect(await diskBootstrap()).not.toHaveProperty("rollbackSnapshotId");
});

test("real shell persists enabled updates and same-org flag rollback without destroying settings", async () => {
  await setDenBootstrapConfig({ ...target, whiteLabelEnabled: true, brandAppName: "Updated workspace" });
  expect(await diskBootstrap()).toMatchObject({ ...branding, whiteLabelEnabled: true, brandAppName: "Updated workspace" });
  await setDenBootstrapConfig({ ...target, whiteLabelEnabled: false });
  expect(await diskBootstrap()).toMatchObject({ ...branding, whiteLabelEnabled: false, brandAppName: "Updated workspace" });
  expect(writes.at(-1)).not.toMatchObject({ brandAppName: null, brandLogoUrl: null, brandIconUrl: null });
  await setDenBootstrapConfig({ ...target, whiteLabelEnabled: true });
  expect(readDenBootstrapConfig()).toMatchObject({ ...branding, whiteLabelEnabled: true, brandAppName: "Updated workspace" });
});

test("real org switch archives original bootstrap and cache before all-null active clear", async () => {
  const icon = Buffer.from("original dormant icon bytes");
  await writeFile(path.join(root, "brand-icon.png"), icon);
  writeDenSettings({ ...readDenSettings(), authToken: "session", activeOrgId: "org-b" }, { persistBootstrap: false });
  for (let attempt = 0; attempt < 100 && readDenBootstrapConfig().brandAppName !== null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(writes[0]).toMatchObject({ brandAppName: null, brandLogoUrl: null, brandIconUrl: null });
  expect(await diskBootstrap()).toMatchObject({ brandAppName: null, brandLogoUrl: null, brandIconUrl: null });
  const archiveRoot = path.join(root, "desktop-brand-rollback");
  const settingsFile = (await readdir(archiveRoot, { recursive: true })).find((name) => name.endsWith("settings.json"));
  expect(settingsFile).toBeDefined();
  if (!settingsFile) throw new Error("Missing shell archive");
  expect(JSON.parse(await readFile(path.join(archiveRoot, settingsFile), "utf8"))).toMatchObject(branding);
  expect(await readFile(path.join(archiveRoot, path.dirname(settingsFile), "brand-icon.png"))).toEqual(icon);
});

test("cross-origin transaction activation failure restores originals and cache with shell-issued receipt", async () => {
  const icon = Buffer.from("preserved icon cache");
  await writeFile(path.join(root, "brand-icon.png"), icon);
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  const storage = window.localStorage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: (key: string, value: string) => {
        if (key === "openwork.den.authToken") throw new Error("activation persistence failed");
        storage.setItem(key, value);
      },
    },
  });
  try {
    const result = await exchangeHandoffAndSignIn("one-time-grant", { ...other, desktopInitiated: false });
    expect(result).toMatchObject({ ok: false, error: "activation persistence failed", grantConsumed: true });
    expect(writes).toHaveLength(2);
    expect(writes[0]).not.toHaveProperty("restoreSnapshotId");
    expect(JSON.stringify(writes[0])).not.toContain("private.example.test");
    expect(writes[1]?.restoreSnapshotId).toBe(receipt);
    expect(await diskBootstrap()).toMatchObject({ ...target, ...branding });
    expect(await readFile(path.join(root, "brand-icon.png"))).toEqual(icon);
    expect(readDenBootstrapConfig()).toMatchObject(branding);
    expect(await diskBootstrap()).not.toHaveProperty("restoreSnapshotId");
  } finally {
    if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
  }
});

test("real shell rejects forged/wrong-target receipts and ignores arbitrary branding strings", async () => {
  await expect(desktop.setDesktopBootstrapConfig({ ...target, restoreSnapshotId: "forged" }))
    .rejects.toThrow("unavailable");
  await expect(desktop.setDesktopBootstrapConfig({ ...other, restoreSnapshotId: receipt }))
    .rejects.toThrow("different Den target");
  await desktop.setDesktopBootstrapConfig({ ...target, brandAppName: "Forged name", brandLogoUrl: "https://forged.example/logo.png" });
  expect(await diskBootstrap()).toMatchObject(branding);
  const fabricated = { ...readDenBootstrapConfig(), rollbackSnapshotId: "forged" };
  await expect(setDenBootstrapConfig(target, { restoreSnapshot: fabricated })).rejects.toThrow("previously read snapshot");
  await setDenBootstrapConfig({ ...target, ...{ restoreSnapshotId: "forged" } });
  expect(writes.at(-1)).not.toHaveProperty("restoreSnapshotId");
  const trusted = readDenBootstrapConfig();
  const issuedReceipt = trusted.rollbackSnapshotId;
  trusted.rollbackSnapshotId = "mutated-after-read";
  await setDenBootstrapConfig(target, { restoreSnapshot: trusted });
  expect(writes.at(-1)?.restoreSnapshotId).toBe(issuedReceipt);
  expect(await diskBootstrap()).toMatchObject(branding);
});
