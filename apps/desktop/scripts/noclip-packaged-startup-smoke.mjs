import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) {
  throw new Error("Packaged startup checks require a disposable Windows CI runner.");
}
const exe = fileURLToPath(new URL("../dist-electron/win-unpacked/NoClip.exe", import.meta.url));
const output = path.join(process.env.RUNNER_TEMP, "noclip-packaged-gui");
const profile = path.join(userInfo().homedir, ".noclip");
const retainedProfile = path.join(process.env.RUNNER_TEMP, "noclip-gui-retained-profile");
assert.ok(existsSync(exe), "Packaged NoClip executable is missing");
assert.equal(existsSync(profile), false, "Refusing to reuse or delete an existing NoClip profile");
assert.equal(existsSync(retainedProfile), false, "Refusing to overwrite retained CI data");
mkdirSync(output);
const marker = path.join(profile, "desktop", "ci-startup-marker.txt");
const observations = [];
const redact = (text) => text.split(/\r?\n/).map((line) =>
  /authorization|bearer\s|api.?key|token|password|secret/i.test(line) ? "[credential-like log line omitted]" : line
).join("\n");

async function connect(url) {
  assert.equal(new URL(url).hostname, "127.0.0.1", "Debugging must remain on loopback");
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Debug connection timed out")), 10000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Debug connection failed")); }, { once: true });
  });
  return {
    close: () => socket.close(),
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 10000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
  };
}

async function launch(attempt) {
  if (attempt === 2) assert.equal(readFileSync(marker, "utf8"), "keep profile across restarts");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"], {
    env, stdio: ["ignore", "pipe", "pipe"], windowsHide: false,
  });
  let log = "";
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  const append = (chunk) => { log = (log + chunk.toString()).slice(-100000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let cdp;
  try {
    const deadline = Date.now() + 90000;
    let target;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`NoClip exited before rendering (${child.exitCode})`);
      const match = log.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match) {
        const endpoint = new URL(match[1]);
        try {
          const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/list`, { signal: AbortSignal.timeout(2000) });
          const targets = await response.json();
          target = targets.find((item) => item.type === "page" && !/^(about:|devtools:|chrome:)/.test(item.url));
          if (target?.webSocketDebuggerUrl) break;
        } catch { /* Chromium may still be opening its debug endpoint. */ }
      }
      await delay(300);
    }
    assert.ok(target?.webSocketDebuggerUrl, "No application page became available");
    cdp = await connect(target.webSocketDebuggerUrl);
    let page;
    while (Date.now() < deadline) {
      const result = await cdp.call("Runtime.evaluate", { returnByValue: true, expression: `(() => {
        const root = document.getElementById('root');
        return { title: document.title, ready: document.readyState,
          mounted: !!root && !document.getElementById('startup-recovery'),
          controls: root ? root.querySelectorAll('button,input,textarea').length : 0,
          text: root ? root.innerText.trim().slice(0,1500) : '' };
      })()` });
      assert.equal(result.exceptionDetails, undefined, "Renderer evaluation failed");
      page = result.result?.value;
      if (page?.mounted && page.controls > 0 && page.text.length > 0) break;
      await delay(300);
    }
    assert.ok(page?.mounted && page.controls > 0 && page.text.length > 0, "Application did not progress beyond its startup placeholder");
    assert.doesNotMatch(page.text, /something went wrong|a javascript error occurred|failed to get 'appData'/i);
    assert.ok(existsSync(path.join(profile, "desktop")), "Separate NoClip userData was not created");
    assert.equal(existsSync(path.join(profile, "runtime", "home", ".noclip")), false, "Restart created a nested profile");
    if (attempt === 1) writeFileSync(marker, "keep profile across restarts");
    else assert.equal(readFileSync(marker, "utf8"), "keep profile across restarts");
    const image = await cdp.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(output, `startup-${attempt}.png`), Buffer.from(image.data, "base64"));
    observations.push({ attempt, ...page });
    await cdp.call("Browser.close").catch(() => {});
    const quitDeadline = Date.now() + 20000;
    while (child.exitCode === null && Date.now() < quitDeadline) await delay(200);
    assert.equal(child.exitCode, 0, "NoClip did not quit cleanly");
  } catch (error) {
    console.error(redact(log).slice(-5000));
    throw error;
  } finally {
    cdp?.close();
    writeFileSync(path.join(output, `startup-${attempt}.log`), redact(log));
    if (child.exitCode === null && child.pid) {
      try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already exited */ }
    }
  }
}
try {
  await launch(1);
  await launch(2);
  // This profile did not exist before this CI test. Preserve it outside the
  // uploaded evidence, rather than deleting it or colliding with the subsequent
  // installer-retention fixtures at runtime/config/server.json and opencode.db.
  for (let attempt = 0; ; attempt++) {
    try { await rename(profile, retainedProfile); break; }
    catch (error) {
      if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      await delay(400);
    }
  }
  const evidence = { ok: true, packagedGuiLoaded: true, repeatedStartup: true,
    profileMarkerPreserved: true, gatewayTested: false, securityClearance: false, observations };
  writeFileSync(path.join(output, "GUI-SMOKE.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} catch (error) {
  writeFileSync(path.join(output, "GUI-SMOKE.json"), JSON.stringify({ ok: false, error: error.message, observations }, null, 2));
  throw error;
}
