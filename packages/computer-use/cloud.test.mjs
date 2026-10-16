import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudComputer } from "./cloud.mjs";

async function fixture(t) {
  let allowed = true;
  const commands = [];
  let screenRead = async () => ({ exitCode: 0, stdout: "1280 800", stderr: "" });
  const directory = await mkdtemp(join(tmpdir(), "cloud-computer-test-"));
  const computer = await createCloudComputer({ directory, enabled: async () => allowed, machine: {
    async run(command) {
      commands.push(command);
      if (command.includes('echo "missing:')) return { exitCode: 0, stdout: "missing:\ndisplay:ok", stderr: "" };
      if (command.endsWith("xdotool getdisplaygeometry")) return screenRead();
      if (command.includes("python3 -c")) return { exitCode: 0, stdout: "[]", stderr: "" };
      if (command.includes("identify -format")) return { exitCode: 0, stdout: "1280 800", stderr: "" };
      return { exitCode: 0, stdout: "done:0", stderr: "" };
    }, read: async () => new Uint8Array([137,80,78,71]),
  } });
  t.after(async () => { await computer.close(); await rm(directory, { recursive: true, force: true }); });
  return { computer, commands, allow: value => { allowed = value; }, screen: read => { screenRead = read; } };
}

test("a disabled rollout grants neither agent tools, images nor human input", async t => {
  const f = await fixture(t); f.allow(false);
  await assert.rejects(f.computer.task("/browser/task", { sessionId: "a", operation: "tabs" }), { code: "feature_disabled" });
  await assert.rejects(f.computer.frame(), { code: "feature_disabled" });
  await assert.rejects(f.computer.interact({ action: "takeover" }), { code: "feature_disabled" });
  assert.deepEqual(f.commands, []);
});
test("enabled computer discovery works immediately without a consent request", async t => {
  const f = await fixture(t);
  const result = await f.computer.task("/computer/task", { sessionId: "a", name: "computer_discover", args: {} });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(f.commands.length > 0);
});
test("human input requires takeover and the exact current view generation", async t => {
  const f = await fixture(t);
  await assert.rejects(f.computer.interact({ type: "type", text: "hello", generation: 0 }), { code: "view_changed" });
  await f.computer.interact({ action: "takeover" });
  const frame = await f.computer.frame();
  await assert.rejects(f.computer.interact({ type: "click", x: 1280, y: 20, generation: frame.generation }), { code: "invalid_point" });
  await f.computer.interact({ type: "type", text: "hello", generation: frame.generation });
  assert.ok(f.commands.some(command => command.includes("xdotool type")));
  await f.computer.interact({ action: "resume" });
  await f.computer.interact({ action: "takeover" });
  await assert.rejects(f.computer.interact({ type: "type", text: "stale", generation: frame.generation }), { code: "view_changed" });
});
test("Continue during a delayed human input check cannot dispatch the old input", async t => {
  const f = await fixture(t);
  await f.computer.interact({ action: "takeover" });
  const frame = await f.computer.frame();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let arrived;
  const checked = new Promise(resolve => { arrived = resolve; });
  f.screen(async () => { arrived(); await waiting; return { exitCode: 0, stdout: "1280 800", stderr: "" }; });
  const input = f.computer.interact({ type: "type", text: "stale", generation: frame.generation });
  await checked;
  await f.computer.interact({ action: "resume" });
  release();
  await assert.rejects(input, { code: "view_changed" });
  assert.ok(!f.commands.some(command => command.includes("xdotool type")));
});
test("the model cannot resume a human takeover through either tool family", async t => {
  const f = await fixture(t);
  await f.computer.interact({ action: "takeover" });
  for (const path of ["/computer/task", "/browser/task"]) await assert.rejects(f.computer.task(path, { sessionId: "a", name: "computer_discover", operation: "tabs" }), { code: "paused" });
});
