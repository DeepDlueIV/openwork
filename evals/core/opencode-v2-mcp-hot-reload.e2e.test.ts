import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import {
  addOtherWorkspace, askAndReadReply, mcpTokenFingerprint, skillLoadSteps,
  workspaceConnectorSteps, workspaceConnectors, workspaceSkills,
} from "@openwork/behaviors";
import { engineConnectorsParity } from "../worlds/engine-connectors-parity.ts";

// Web app + a Den org connection ("Amber Reports") reached through OpenWork Cloud, on
// the engine the run selects. The same report service doubles as a workspace connector
// added through OpenWork's server, the way Settings adds one. Only the model is scripted.
const test = spec.world(engineConnectorsParity, {
  timeout: 900_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const SERVER = "reload-witness";
const TOOL = "current_amber_report";
const SKILL = "amber-release-briefing";

test(`CONNECTOR-CHANGES-LIVE ${resolveEvalEngine()}: connectors and skills added or removed reach the ongoing conversation on its next turn, without a restart`, async ({ world, user, probe, step, evidence }) => {
  const connectors = workspaceConnectors(world.request, world.workspace);
  const skills = workspaceSkills(world.request, world.workspace, world.engine);
  const report = world.den.mocks.report;
  const route = await probe.hash();
  const runtime = await world.runtime();
  let turn = 0;
  const ask = (prepare: (prompt: string) => Promise<void>) =>
    askAndReadReply({ user, probe }, `Read the current amber report. Request ${++turn}.`, prepare);
  const askConnector = () => ask((prompt) => world.prepareTurn(prompt, "UNAVAILABLE", workspaceConnectorSteps(world.engine, SERVER, TOOL), "last-tool-text"));
  const callsSince = async (sinceIso: string) => report.toolCalls({ name: TOOL, sinceIso });

  await step("a connector added through OpenWork answers on the very next turn", async () => {
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    expect(await connectors.add(SERVER, report.mcpUrl, "eval-first")).toBe(200);
    const sinceIso = new Date().toISOString();
    const reply = await askConnector();
    expect(reply).toContain(world.proof);
    const calls = await callsSince(sinceIso);
    expect(calls.map((call) => call.tokenId)).toEqual([mcpTokenFingerprint("eval-first")]);
    await user.screenshot();
  });

  await step("replacing its credential takes effect on the next turn and stays in this workspace", async () => {
    if (world.engine === "v2") expect(await connectors.writeEngineDirectly(SERVER, report.mcpUrl, "eval-bypass"), "the engine's own MCP config is not writable around OpenWork").toBe(403);
    expect(await connectors.add(SERVER, report.mcpUrl, "eval-second")).toBe(200);
    const sinceIso = new Date().toISOString();
    expect(await askConnector()).toContain(world.proof);
    const tokens = (await callsSince(sinceIso)).map((call) => call.tokenId);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((token) => token === mcpTokenFingerprint("eval-second"))).toBe(true);
    const other = await addOtherWorkspace(world.hostRequest, world.request, `${world.workspacePath}-unrelated`);
    expect(other).not.toBe(world.workspace);
    expect(await connectors.lists(SERVER, other), "another workspace never receives this connector").toBe(false);
    expect(await connectors.lists(SERVER)).toBe(true);
    evidence.recordAssertionEvidence("A credential change reaches only the next turn of this workspace",
      `${tokens.length} report call(s), all with the replacement credential; the other workspace lists no ${SERVER}`, tokens.length > 0);
  });

  await step("removing the connector stops the next call; the report service receives nothing", async () => {
    expect(await connectors.remove(SERVER)).toBe(200);
    const sinceIso = new Date().toISOString();
    const reply = await askConnector();
    expect(reply).not.toContain(world.proof);
    if (world.engine === "v2") expect(reply).toMatch(/Unknown tool/);
    expect(await callsSince(sinceIso)).toEqual([]);
    expect(await connectors.lists(SERVER)).toBe(false);
    await user.screenshot();
  });

  await step("the organization's Amber Reports connection works in the same conversation", async () => {
    const sinceIso = new Date().toISOString();
    expect(await ask((prompt) => world.prepareDirectReport(prompt))).toContain(world.proof);
    expect((await callsSince(sinceIso)).length).toBeGreaterThan(0);
  });

  await step("after an admin deletes Amber Reports in Den, the next turn cannot run it and the service receives nothing", async () => {
    expect(await world.retireReports()).toBe(200);
    const sinceIso = new Date().toISOString();
    const reply = await ask((prompt) => world.prepareDirectReport(prompt));
    expect(reply).not.toContain(world.proof);
    expect(await callsSince(sinceIso)).toEqual([]);
    await user.screenshot();
  });

  await step("a skill installed mid-conversation is used on the next turn; removing it makes it unavailable", async () => {
    const code = `AMBER-${Date.now().toString(36)}`;
    expect(await skills.install(SKILL, "Answers amber release report requests.", `For amber release report requests, reply with the current code: ${code}.`)).toBe(200);
    await probe.eventually(() => skills.engineEntry(SKILL), { within: 15_000, label: "the engine lists the new skill", until: (entry) => entry !== "" });
    const askSkill = () => ask((prompt) => world.prepareTurn(prompt, "UNAVAILABLE", skillLoadSteps(world.engine, SKILL), "last-tool-text"));
    expect(await askSkill()).toContain(code);
    expect(await skills.remove(SKILL)).toBe(200);
    await probe.eventually(() => skills.engineEntry(SKILL), { within: 15_000, label: "the engine drops the skill", until: (entry) => entry === "" });
    const after = await askSkill();
    expect(after).not.toContain(code);
    expect(after).toMatch(/UNAVAILABLE|not found|not available|Unable to load skill/i);
    await user.screenshot();
  });

  await step("the conversation and engine never restarted", async () => {
    expect(await probe.hash()).toBe(route);
    if (world.engine === "v2") expect((await world.runtime()).pid).toBe(runtime.pid);
    await user.see("composer", { editable: true });
  });
});
