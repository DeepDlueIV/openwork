import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { PROVIDER_NAME, secureKeysAutomation } from "../worlds/secure-keys-automation.ts";

// SECRETS-STAY-PRIVATE's second journey: the Automation half of the promise
// needs a real OpenWork Web computer and the Automations runtime, which the
// chat journey's browser app does not have.
const test = spec.world(secureKeysAutomation, {
  timeout: 1_200_000,
  needs: { optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["bun"], placement: "local" },
  resources: { surfaces: [], services: ["den"] },
});

test("an Automation owner without their own provider key is told to get one, and is never given a teammate's", async ({ world, step }) => {
  let automationId = "";

  await step("given: the team's provider gives each member their own key, and only the teammate has one", async () => {
    expect(await world.saveOwnKey("teammate")).toBe(200);
    expect(await world.keyState("owner")).toBe("missing");
    expect(await world.keyState("teammate")).toBe("active");
  });

  await step("given: the owner's computer is ready and the teammate's key was not put on it", async () => {
    const resolved = await world.resolveOwnersComputer();
    expect(resolved).toMatchObject({ status: 200, state: "ready", url: world.computerUrl });
    const onComputer = await world.keyOnOwnersComputer();
    expect(onComputer.provider).toBe(false);
    expect(onComputer.holder).not.toBe("teammate");
  });

  await step("when the owner runs a Cloud Automation on that model, it stops and says they need their own key", async () => {
    const started = await world.createAndRunAutomation();
    expect(started).toMatchObject({ created: 201, queued: 202 });
    automationId = started.automationId;
    const run = await world.finishedRun(started.runId);
    expect(run).toMatchObject({ status: "failed", code: "provider_unavailable" });
    expect(run.message).toContain(PROVIDER_NAME);
    expect(run.message).toContain("no active key");
    expect(run.message).not.toContain("OpenWork Connect");
    expect(await world.automation(automationId)).toEqual({ state: "needs_attention", reason: { code: "provider_unavailable", message: run.message } });
  });

  await step("then: once the owner saves their own key, their computer receives that key and not the teammate's", async () => {
    expect(await world.saveOwnKey("owner")).toBe(200);
    const onComputer = await world.waitForProviderOnOwnersComputer();
    expect(onComputer).toEqual({ provider: true, holder: "owner" });
  });

  await step("after: the owner resumes the Automation, and nothing reached the Daytona API", async () => {
    expect(await world.resume(automationId)).toEqual({ status: 200, state: "active" });
    expect((await world.automation(automationId)).reason).toBeNull();
    expect(world.daytonaRequests()).toEqual([]);
  });
});
