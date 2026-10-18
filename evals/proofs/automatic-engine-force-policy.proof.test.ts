import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { automaticEngineForcePolicy, failedEngineForcePolicy, retainedHistoryText, newV2HistoryText, newV2Prompt, continuedWorkPrompt, continuedWorkText } from "../worlds/automatic-engine-force-policy.ts";

const test = spec.world(automaticEngineForcePolicy, {
  timeout: 240_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { commands: ["bun", "opencode"] },
});
const failure = spec.world(failedEngineForcePolicy, {
  timeout: 180_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { commands: ["bun", "opencode"] },
});

failure("a member keeps using the original chat after an automatic upgrade fails", async ({ world, user, probe, step, evidence }) => {
  let retryAt: number | undefined;
  await step("before: an unavailable new engine leaves the existing note readable on v1", async () => {
    await world.setOrganizationPolicy(true);
    const status = await probe.eventually(() => world.status(), {
      within: 20_000, label: "the host retains a failed upgrade receipt", until: value => value.migration.state === "error",
    });
    expect(status.chatRouting).toBe(false);
    expect(status.automaticRetryAt).toBeGreaterThan(Date.now());
    retryAt = status.automaticRetryAt;
    await user.reload();
    await user.see({ text: retainedHistoryText });
    expect(await world.messages()).toContain(retainedHistoryText);
    evidence.recordAssertionEvidence("A real failed engine start keeps the original chat selected", JSON.stringify(status), status.migration.state === "error" && !status.chatRouting);
    await user.screenshot();
  });
  await step("after: the member sends and reads a new reply on the current engine", async () => {
    await user.type("composer", continuedWorkPrompt);
    await user.press("ENTER");
    await user.see({ text: continuedWorkText }, { timeoutMs: 60_000 });
    const messages = await world.messages();
    expect(messages).toContain(continuedWorkText);
    const status = await world.status();
    expect(status.chatRouting).toBe(false);
    evidence.recordAssertionEvidence("The selected original engine persists new work while the upgrade is paused", messages.slice(-500), !status.chatRouting && messages.includes(continuedWorkText));
    await user.screenshot();
  });
  await step("reloading and refreshing policy keep the failure without a duplicate attempt", async () => {
    await world.setOrganizationPolicy(true);
    await user.reload();
    await user.see({ text: retainedHistoryText });
    await user.see({ text: continuedWorkText });
    const retry = await world.manualRetry();
    expect(retry.status).toBe(409);
    expect(retry.body).toContain("engine_upgrade_host_managed");
    const status = await world.status();
    expect(status.automaticRetryAt).toBe(retryAt);
    expect(status.migration.state).toBe("error");
    evidence.recordAssertionEvidence("The same failure and cooldown survive use; a duplicate copy is refused", `${JSON.stringify(status)}; retry HTTP ${retry.status} ${retry.body}`, !status.chatRouting && status.migration.state === "error" && status.automaticRetryAt === retryAt && retry.status === 409 && retry.body.includes("engine_upgrade_host_managed"));
    await user.screenshot();
  });
});

test("a member keeps a new v2 chat readable when automatic engine policy turns off", async ({ world, user, probe, step, evidence }) => {
  let sessionId = "";
  let automaticOrigin = "";
  async function noUpgradeUi() {
    for (const testId of ["engine-upgrade-notice", "engine-migration-consent", "engine-migration-banner", "engine-migration-progress", "engine-switch-prompt"]) {
      await user.notSee({ testId });
    }
  }
  await step("before: automatic policy is off and the profile uses v1 without an upgrade notice", async () => {
    await user.reload();
    await user.see("composer", { editable: true });
    const status = await world.status();
    expect(status.chatRouting).toBe(false);
    await noUpgradeUi();
    evidence.recordAssertionEvidence("The starting profile uses v1", JSON.stringify(status), !status.chatRouting);
    await user.screenshot();
  });

  await step("turning automatic policy on selects a healthy v2 engine without asking the member", async () => {
    await world.setOrganizationPolicy(true);
    const status = await probe.eventually(() => world.status(), {
      within: 120_000, label: "the force-owned v2 engine is healthy",
      until: value => value.chatRouting && value.running && value.engineForced,
    });
    automaticOrigin = status.engineOrigin;
    await user.reload();
    await noUpgradeUi();
    evidence.recordAssertionEvidence("A force-owned v2 engine is selected", JSON.stringify(status), status.engineForced && status.chatRouting && status.running);
    await user.screenshot();
  });

  await step("the member creates a chat and reply that exist only on the new engine", async () => {
    await user.click({ role: "button", text: /New session/ });
    await user.type("composer", newV2Prompt);
    await user.press("ENTER");
    await user.see({ text: newV2HistoryText }, { timeoutMs: 60_000 });
    sessionId = (await probe.hash()).match(/\/session\/([^/?#]+)/)?.[1] ?? "";
    expect(sessionId).not.toBe("");
    const current = await world.messages(sessionId);
    const original = await world.originalMessages(sessionId);
    expect(current).toContain(newV2HistoryText);
    expect(original).not.toContain(newV2HistoryText);
    await probe.eventually(() => world.v2Idle(), { within: 20_000, label: "the new chat has finished its turn", until: value => value });
    evidence.recordAssertionEvidence("The new reply exists in v2 but not the original v1 history", newV2HistoryText, current.includes(newV2HistoryText) && !original.includes(newV2HistoryText));
    await user.screenshot();
  });

  await step("after: turning policy off keeps the new chat and reply readable on v2", async () => {
    await world.setOrganizationPolicy(false);
    await user.reload();
    await user.see({ text: newV2HistoryText });
    const status = await world.status();
    expect(status.chatRouting).toBe(true);
    expect(status.running).toBe(true);
    expect(status.engineForced).toBe(true);
    expect(status.engineOrigin).toBe(automaticOrigin);
    expect(await world.messages(sessionId)).toContain(newV2HistoryText);
    await noUpgradeUi();
    evidence.recordAssertionEvidence("Policy off keeps the selected v2 engine serving its new history", JSON.stringify(status), status.running && status.chatRouting && status.engineForced);
    await user.screenshot();
  });

  await step("an explicit manual v2 choice is not undone when organization policy stays off", async () => {
    await world.chooseV2Manually();
    await world.setOrganizationPolicy(false);
    const status = await probe.eventually(() => world.status(), {
      within: 60_000,
      label: "the member's manual v2 selection stays healthy with policy off",
      until: value => value.running && value.chatRouting && !value.engineForced && value.engineOrigin === "manual",
    });
    expect(await world.messages(sessionId)).toContain(newV2HistoryText);
    await user.reload();
    await user.see({ text: newV2HistoryText });
    await noUpgradeUi();
    evidence.recordAssertionEvidence("Policy off leaves the explicit manual v2 choice alone", JSON.stringify(status), status.chatRouting && !status.engineForced && status.engineOrigin === "manual");
    await user.screenshot();
  });
});
