import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { sessionModelReassignmentV1 } from "../worlds/session-model-reassignment.ts";

const test = spec.world(sessionModelReassignmentV1, {
  timeout: 8 * 60_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

test("a member on the legacy engine gets an explicit refusal without changing their conversation", async ({ world, user, agent, probe, step, evidence }) => {
  const target = world.fixtures.target;
  const before = await world.read(target);
  const route = await probe.hash();
  const calls = (await world.requests()).length;
  await step("given: the legacy conversation can be read without opening it", async () => {
    expect(before).toMatchObject({ ok: true, result: { ok: true, engine: "v1" } });
    evidence.recordAssertionEvidence("The conversation is held by v1", "session.read finds the target on engine v1", true);
  });
  await step("when: a standalone model change is refused on the legacy engine", async () => {
    await expect(agent.run("session.set_model", {
      sessionId: target, workspaceId: world.workspace.workspaceId, providerId: "rebind", modelId: "model-b",
    })).rejects.toThrow("Session model reassignment requires the OpenCode v2 session API.");
    expect(await probe.hash()).toBe(route);
    expect((await world.requests()).length).toBe(calls);
    evidence.recordAssertionEvidence("v1 is refused without navigation or inference", "Explicit v2-required error; route unchanged; no provider calls", true);
  });
  await step("after: a reload leaves the legacy conversation untouched", async () => {
    await user.reload();
    await user.see("composer", { editable: true });
    expect(await world.read(target)).toEqual(before);
    expect((await world.requests()).length).toBe(calls);
    evidence.recordAssertionEvidence("Legacy history and binding remain unchanged", "session.read matches the original record after reload; no inference", true);
  });
});
