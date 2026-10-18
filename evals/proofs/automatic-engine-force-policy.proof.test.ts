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
    const status = await world.status();
    expect(status.automaticRetryAt).toBe(retryAt);
    expect(status.migration.state).toBe("error");
    evidence.recordAssertionEvidence("The same durable failure and cooldown survive continued use", JSON.stringify(status), !status.chatRouting && status.migration.state === "error" && status.automaticRetryAt === retryAt);
    await user.screenshot();
  });
});

test("a member keeps reading the same chat when automatic engine policy turns on and off", async ({ world, user, probe, step, evidence }) => {
  async function noUpgradeUi() {
    for (const testId of ["engine-upgrade-notice", "engine-migration-consent", "engine-migration-banner", "engine-migration-progress", "engine-switch-prompt"]) {
      await user.notSee({ testId });
    }
  }
  await step("before: automatic policy is off and a real v1 chat is readable without an upgrade notice", async () => {
    await user.reload();
    await user.see({ text: retainedHistoryText });
    const status = await world.status();
    expect(status.chatRouting).toBe(false);
    await noUpgradeUi();
    evidence.recordAssertionEvidence("The starting chat belongs to v1", JSON.stringify(status), !status.chatRouting);
    await user.screenshot();
  });

  await step("after: turning automatic policy on copies the chat and serves it on v2 without asking the member", async () => {
    await world.setOrganizationPolicy(true);
    const status = await probe.eventually(() => world.status(), {
      within: 120_000,
      label: "the real copied chat is served by the forced v2 engine",
      until: value => value.chatRouting && value.running && value.engineForced && value.migration.state === "completed",
    });
    expect(status.engineOrigin).toBe("forced");
    expect(status.migration.imported).toBe(1);
    expect(status.migration.backupPath).toBeTruthy();
    expect(await world.messages()).toContain(retainedHistoryText);
    await user.reload();
    await user.see({ text: retainedHistoryText });
    await noUpgradeUi();
    evidence.recordAssertionEvidence("A forced v2 engine serves the copied chat with a backup receipt", JSON.stringify(status), status.engineForced && status.chatRouting && Boolean(status.migration.backupPath));
    await user.screenshot();
  });

  await step("the member adds a reply that exists only on the new engine", async () => {
    await user.type("composer", newV2Prompt);
    await user.press("ENTER");
    await user.see({ text: newV2HistoryText }, { timeoutMs: 60_000 });
    const current = await world.messages();
    const original = await world.originalMessages();
    expect(current).toContain(newV2HistoryText);
    expect(original).not.toContain(newV2HistoryText);
    evidence.recordAssertionEvidence("The new reply exists in v2 but not the original v1 history", newV2HistoryText, current.includes(newV2HistoryText) && !original.includes(newV2HistoryText));
    await user.screenshot();
  });

  await step("after: turning policy off keeps both the copied note and new reply readable on v2", async () => {
    await world.setOrganizationPolicy(false);
    await user.reload();
    await user.see({ text: retainedHistoryText });
    await user.see({ text: newV2HistoryText });
    const status = await world.status();
    expect(status.chatRouting).toBe(true);
    expect(status.running).toBe(true);
    expect(status.engineForced).toBe(true);
    expect(status.engineOrigin).toBe("forced");
    expect(await world.messages()).toContain(newV2HistoryText);
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
    expect(await world.messages()).toContain(retainedHistoryText);
    await user.reload();
    await user.see({ text: retainedHistoryText });
    await noUpgradeUi();
    evidence.recordAssertionEvidence("Policy off leaves the explicit manual v2 choice alone", JSON.stringify(status), status.chatRouting && !status.engineForced && status.engineOrigin === "manual");
    await user.screenshot();
  });
});
