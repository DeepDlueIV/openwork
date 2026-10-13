import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { firstRunNpmRegistry, LOCAL_TOOL, SLOW_METADATA_MS } from "../worlds/first-run-npm-registry.ts";

const test = spec.world(firstRunNpmRegistry, {
  resources: { surfaces: [], services: [] },
  needs: { commands: ["bun"] },
  timeout: 60_000,
});
const PLUGIN_PACKAGE = "/@opencode-ai/plugin";

function sessionID(value: unknown): string {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") throw new Error("Missing session id");
  return value.id;
}

test("someone opening OpenWork for the first time where the npm registry never answers gets a working workspace within seconds", { timeout: 300_000 }, async ({ world, step, evidence }) => {
  let started: Awaited<ReturnType<typeof world.boot>> | undefined;
  await step("given a fresh profile whose npm registry accepts connections and never answers", async () => {
    started = await world.boot("silent");
    evidence.recordAssertionEvidence("registry", `${started.registryUrl} answered ${started.registry.filter((request) => request.answered).length} of ${started.registry.length} requests`, true);
  });
  if (!started) throw new Error("OpenWork did not start");
  const booted = started;

  await step("then the engine really asked that registry for its plugin package and got nothing back", async () => {
    const asked = booted.registry.filter((request) => request.path === PLUGIN_PACKAGE);
    const answered = asked.filter((request) => request.answered).length;
    evidence.recordAssertionEvidence("plugin package requests", `${asked.length} × GET ${PLUGIN_PACKAGE}, ${answered} answered`, asked.length > 0 && answered === 0);
    expect(asked.length).toBeGreaterThan(0);
    expect(answered).toBe(0);
  });

  await step("after: the workspace answered within 45 s of OpenWork starting", async () => {
    evidence.recordAssertionEvidence("first workspace answer", `${(booted.answeredMs / 1000).toFixed(1)} s after OpenWork started`, booted.answeredMs < 45_000);
    expect(booted.answeredMs).toBeLessThan(45_000);
  });

  await step("after: a new session opens in that workspace", async () => {
    const id = sessionID(await booted.engine("POST", "/session", {}));
    evidence.recordAssertionEvidence("new session", id, id.length > 0);
    expect(id).toMatch(/^ses_/);
  });
});

test("someone on a slow connection still gets their workspace's own plugin that imports @opencode-ai/plugin", { timeout: 300_000 }, async ({ world, step, evidence }) => {
  let started: Awaited<ReturnType<typeof world.boot>> | undefined;
  await step("given a fresh profile whose npm registry takes 13 s to send the plugin package, a few bytes at a time", async () => {
    started = await world.boot("slow");
    evidence.recordAssertionEvidence("registry", `${started.registryUrl} sends ${PLUGIN_PACKAGE} over ${SLOW_METADATA_MS / 1000} s; workspace answered after ${(started.answeredMs / 1000).toFixed(1)} s`, true);
  });
  if (!started) throw new Error("OpenWork did not start");
  const booted = started;

  await step("then that download really ran longer than npm's 10 s request limit and finished", async () => {
    const finished = booted.registry.filter((request) => request.path === PLUGIN_PACKAGE && request.answered);
    const longest = Math.max(0, ...finished.map((request) => request.ms));
    evidence.recordAssertionEvidence("plugin package download", `${finished.length} finished; longest ${(longest / 1000).toFixed(1)} s`, longest > 10_000);
    expect(longest).toBeGreaterThan(10_000);
  });

  await step(`after: the workspace's own ${LOCAL_TOOL} tool is available`, async () => {
    const ids = await booted.engine("GET", "/experimental/tool/ids");
    const loaded = Array.isArray(ids) && ids.includes(LOCAL_TOOL);
    evidence.recordAssertionEvidence("workspace tools", loaded ? `${LOCAL_TOOL} listed among ${ids.length} tools` : `${LOCAL_TOOL} missing from ${JSON.stringify(ids).slice(0, 200)}`, loaded);
    expect(loaded).toBe(true);
  });
});
