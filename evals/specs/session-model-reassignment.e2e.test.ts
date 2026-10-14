import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { sessionModelReassignment } from "../worlds/session-model-reassignment.ts";

const test = spec.world(sessionModelReassignment, {
  timeout: 8 * 60_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function result(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error("Invalid action result");
  return record(value.result) ? value.result : value;
}

test("a member recovers a conversation by id without opening it or starting inference", async ({ world, agent, user, probe, step, evidence }) => {
  const { target, untouched, busy } = world.fixtures;
  const args = { sessionId: target, workspaceId: world.workspace.workspaceId, providerId: "rebind", modelId: "model-b" };
  const route = await probe.hash();
  const requestsBefore = (await world.requests()).length;
  const untouchedBefore = await world.read(untouched);
  await step("given: the conversation belongs to a different workspace than the one on screen", async () => {
    expect(route).toContain(world.other.workspaceId);
    const before = result(await world.read(target));
    expect(before.ok).toBe(true);
    expect(before.model).toMatchObject({ providerId: "rebind", modelId: "model-a" });
    evidence.recordAssertionEvidence("The recovery target is not the selected workspace", `engine=${world.engine}; selected workspace differs; initial model=${JSON.stringify(before.model)}`, true);
  });
  await step("when: the member chooses an exact replacement without opening the conversation", async () => {
    const response = result(await agent.run("session.set_model", args));
    expect(response).toMatchObject({ ok: true, model: { providerId: "rebind", modelId: "model-b", variant: null } });
    expect(await probe.hash()).toBe(route);
    expect((await world.requests()).length).toBe(requestsBefore);
    evidence.recordAssertionEvidence("Reassignment does not navigate or infer", `${world.engine}: ${JSON.stringify(response)}; route unchanged; provider calls unchanged`, true);
  });
  await step("after: the saved model remains correct after reloading OpenWork", async () => {
    await user.reload();
    await user.see("composer", { editable: true });
    const read = result(await world.read(target));
    expect(read.ok).toBe(true);
    expect(read.model).toMatchObject({ providerId: "rebind", modelId: "model-b", variant: null });
    expect((await world.read(untouched))).toEqual(untouchedBefore);
    expect((await world.requests()).length).toBe(requestsBefore);
    evidence.recordAssertionEvidence("Reload keeps the persisted binding and leaves the other conversation untouched", `${world.engine}: session.read model=${JSON.stringify(read.model)}; unrelated session unchanged; no inference`, true);
  });
  await step("then: an unavailable model cannot replace the saved selection", async () => {
    await expect(agent.run("session.set_model", { ...args, modelId: "not-available" })).rejects.toThrow("Unavailable model");
    expect(result(await world.read(target)).model).toMatchObject({ providerId: "rebind", modelId: "model-b" });
    expect((await world.requests()).length).toBe(requestsBefore);
    evidence.recordAssertionEvidence("Unavailable replacement is rejected before inference", "requested model is absent; saved model remains Model B; provider calls unchanged", true);
  });
  await step("then: naming the wrong workspace cannot modify a foreign conversation", async () => {
    const response = await agent.run("session.set_model", { ...args, workspaceId: world.other.workspaceId, modelId: "model-a" }).catch(error => ({ ok: false, error: String(error) }));
    expect(result(response).ok).toBe(false);
    expect(result(await world.read(target)).model).toMatchObject({ providerId: "rebind", modelId: "model-b" });
    evidence.recordAssertionEvidence("Wrong workspace is refused", `${JSON.stringify(response)}; original binding remains Model B`, true);
  });
  await step("then: an archived conversation cannot be rebound", async () => {
    if (!world.archived) throw new Error("Missing genuinely archived engine fixture");
    const before = result(await world.read(world.archived));
    expect(before.archived).toBe(true);
    await expect(agent.run("session.set_model", { ...args, sessionId: world.archived })).rejects.toThrow("Archived sessions");
    expect(result(await world.read(world.archived))).toEqual(before);
    expect((await world.requests()).length).toBe(requestsBefore);
    evidence.recordAssertionEvidence("An imported archived conversation is refused without mutation", "session.read archived=true before and after; native archived fixture unchanged; no inference", true);
  });
  await step("then: a conversation with active work cannot be rebound", async () => {
    const prompt = await agent.desktopApi(`${world.base}/session/${busy}/prompt`, { method: "POST", body: { text: "hold model reassignment" } });
    expect(prompt.status).toBeLessThan(300);
    try {
      await probe.eventually(() => probe.desktopApi(`${world.base}/session/active`), {
        within: 30_000, label: "native engine reports the conversation active",
        until: value => JSON.stringify(value.body).includes(busy),
      });
      await expect(agent.run("session.set_model", { ...args, sessionId: busy })).rejects.toThrow("Working sessions");
      expect(result(await world.read(busy)).model).toMatchObject({ providerId: "rebind", modelId: "model-a" });
      evidence.recordAssertionEvidence("An active conversation is not rebound", "native active list contains target; rebind refused; Model A retained", true);
    } finally {
      await agent.desktopApi(`${world.base}/session/${busy}/interrupt`, { method: "POST", body: {} });
    }
  });
  const callsBeforeOpen = (await world.requests()).length;
  await step("after: reopening the recovered conversation shows the replacement model", async () => {
    await user.navigate(`${world.app.webUrl}/workspace/${world.workspace.workspaceId}/session/${target}`);
    await user.see("composer", { editable: true });
    await user.see({ role: "button", label: "Change model" }, { text: "Model B" });
    expect(result(await world.read(target)).model).toMatchObject({ providerId: "rebind", modelId: "model-b" });
    expect((await world.requests()).length).toBe(callsBeforeOpen);
    evidence.recordAssertionEvidence("The composer keeps the recovered choice", "Reopened conversation shows Model B and session.read still reports Model B", true);
    await user.screenshot();
  });
});
