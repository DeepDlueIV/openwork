import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { engineConnectorsParity } from "../worlds/engine-connectors-parity.ts";

const test = spec.world(engineConnectorsParity, {
  timeout: 600_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

test(`PARITY-CONNECTORS ${resolveEvalEngine()}: search assigned capabilities, execute a connector and show its result`, async ({ world, user, step }) => {
  const document = await world.documentIdentity();
  const runtime = await world.runtime();
  await step("Connect checks the engine used for chat and can repair its connection", async () => {
    expect(await world.connectHealth()).toMatchObject({ status: 200, body: { usable: true, usableByCurrentModel: true, firstFailure: null } });
    expect(await world.connectHealth(true)).toMatchObject({ status: 200, body: { refresh: { performed: true }, health: { usable: true, usableByCurrentModel: true, firstFailure: null } } });
  });
  await step("Ask for a report without knowing its capability ID or result", async () => {
    const prompt = "Read the latest amber report using my connections.";
    await world.prepareReport(prompt);
    expect(prompt).not.toContain(world.proof);
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: world.proof }, { timeoutMs: 90_000 });
    await user.see("Run task");
    const calls = await world.den.mocks.report.toolCalls();
    expect(calls).toMatchObject([{ name: "current_amber_report", args: {} }]);
    const requests = await world.mock.agentRequests({ promptMarker: prompt });
    expect(requests.some((request) => request.kind === "error")).toBe(false);
    if (world.engine === "v1") expect(requests.filter((request) => request.kind === "tool").map((request) => request.toolName))
      .toEqual([expect.stringMatching(/search_capabilities$/), expect.stringMatching(/execute_capability$/)]);
    await user.screenshot();
  });
  const route = await world.route();
  await step("A connector failure is returned truthfully in the same conversation", async () => {
    const prompt = "Read the unavailable amber report using my connections.";
    await world.prepareReport(prompt, true);
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: /requested provider operation failed/ }, { timeoutMs: 90_000 });
    await user.see("Run task");
    expect((await world.den.mocks.report.toolCalls()).map((call) => call.name)).toEqual(["current_amber_report", "unavailable_violet_status"]);
    expect(await world.route()).toBe(route);
    expect(await world.documentIdentity()).toBe(document);
    if (world.engine === "v2") expect((await world.runtime()).pid).toBe(runtime.pid);
    await user.screenshot();
  });
  await step("a Cloud script calls the connector 120 times in one run, and a runaway script stops at 1,024 calls", async () => {
    const path = await world.scriptPath();
    expect(path).toMatch(/^tools\./);
    let since = new Date().toISOString();
    const bulk = await world.runScript(`return { looked: (await Promise.all(Array.from({ length: 120 }).map(() => ${path}({})))).length };`);
    expect(bulk).toEqual({ ok: true, value: { looked: 120 } });
    expect(await world.den.mocks.report.toolCalls({ name: "current_amber_report", sinceIso: since })).toHaveLength(120);
    since = new Date().toISOString();
    const runaway = await world.runScript(`for (let batch = 0; batch < 200; batch += 1) await Promise.all(Array.from({ length: 8 }).map(() => ${path}({})));\nreturn "unreachable";`);
    expect(runaway).toEqual({ ok: false, kind: "ToolCallLimitExceeded", message: "Execution exceeded its tool-call limit of 1024." });
    const served = (await world.den.mocks.report.toolCalls({ name: "current_amber_report", sinceIso: since })).length;
    expect(served).toBeLessThanOrEqual(1_024);
    expect(served).toBeGreaterThan(1_024 - 8);
  });
});
