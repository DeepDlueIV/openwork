import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { z } from "zod";
import { engineUpgradePaused } from "../worlds/engine-upgrade-paused.ts";

const test = spec.world(engineUpgradePaused, {
  timeout: 240_000,
  resources: {
    surfaces: ["desktop"], services: [],
    nativeReason: "Desktop-only host migration discovery and native restart recovery; run in a sandbox, not a local window.",
  },
});

const upgradeStatus = z.object({
  chatRouting: z.boolean(),
  automaticRetryAt: z.number().optional(),
  migration: z.object({ state: z.string(), error: z.string().optional(), startedAt: z.string().optional() }),
});
type UpgradeStatus = z.infer<typeof upgradeStatus>;

test("a member keeps working with a visible paused upgrade and restart recovery", async ({ user, probe, step, evidence }) => {
  let failed: UpgradeStatus | undefined;
  await step("before: the new engine cannot start and the current chat remains on v1", async () => {
    failed = upgradeStatus.parse((await probe.desktopApi("/experimental/engine-v2-preview/status")).body);
    expect(failed.migration.state).toBe("error");
    expect(failed.migration.error).toContain("unavailable-fixture-engine");
    expect(failed.chatRouting).toBe(false);
    await user.see({ testId: "engine-migration-banner" });
    await user.see({ text: "Chat upgrade paused" });
    await user.see({ text: "Using OpenCode v1" });
    await user.notSee({ testId: "engine-migration-progress" });
    evidence.recordAssertionEvidence("The actual host failed once and kept v1 selected", JSON.stringify(failed), failed.migration.state === "error" && !failed.chatRouting);
    await user.screenshot();
  });

  await step("after: the member can type while the paused notice remains compact", async () => {
    await user.type("composer", "Keep this draft while the upgrade is paused.");
    const draft = await probe.composer();
    expect(draft.draftText).toContain("Keep this draft while the upgrade is paused.");
    await user.notSee({ testId: "engine-migration-recovery" });
    evidence.recordAssertionEvidence("Chat input stays usable without a blocking recovery dialog", draft.draftText, draft.draftText.includes("Keep this draft"));
    await user.screenshot();
  });

  await step("reviewing recovery discloses the later restart without running another copy", async () => {
    await user.click({ role: "button", text: "Review upgrade" });
    await user.see({ testId: "engine-migration-recovery" });
    await user.see({ role: "button", text: "Restart OpenWork" });
    await user.see({ text: "Technical details" });
    await user.notSee({ role: "button", text: "Try again" });
    const current = upgradeStatus.parse((await probe.desktopApi("/experimental/engine-v2-preview/status")).body);
    expect(current.automaticRetryAt).toBe(failed?.automaticRetryAt);
    expect(current.migration.error).toBe(failed?.migration.error);
    evidence.recordAssertionEvidence("Recovery leaves the host attempt and its cooldown unchanged", JSON.stringify(current), current.automaticRetryAt === failed?.automaticRetryAt && current.migration.state === "error");
    await user.screenshot();
  });

  await step("closing and reloading preserve both the paused failure and the member's draft", async () => {
    await user.click({ role: "button", text: "Keep working" });
    await user.notSee({ testId: "engine-migration-recovery" });
    await user.reload();
    await user.see({ testId: "engine-migration-banner" });
    const draft = await probe.composer();
    expect(draft.draftText).toContain("Keep this draft while the upgrade is paused.");
    const current = upgradeStatus.parse((await probe.desktopApi("/experimental/engine-v2-preview/status")).body);
    expect(current.automaticRetryAt).toBe(failed?.automaticRetryAt);
    evidence.recordAssertionEvidence("Reload discovers the durable error without a duplicate migration attempt", JSON.stringify(current), !current.chatRouting && current.migration.state === "error" && current.automaticRetryAt === failed?.automaticRetryAt);
    await user.screenshot();
  });
  await step("manual recovery asks for consent and can be cancelled without losing the draft", async () => {
    await user.click({ role: "button", text: "Review upgrade" });
    await user.click({ role: "button", text: "Migrate chats" });
    await user.see({ testId: "engine-migration-consent" });
    await user.notSee({ testId: "engine-migration-recovery" });
    const current = upgradeStatus.parse((await probe.desktopApi("/experimental/engine-v2-preview/status")).body);
    expect(current.automaticRetryAt).toBe(failed?.automaticRetryAt);
    await user.click({ role: "button", text: "Cancel" });
    await user.see({ testId: "engine-migration-banner" });
    const draft = await probe.composer();
    expect(draft.draftText).toContain("Keep this draft while the upgrade is paused.");
    evidence.recordAssertionEvidence("Requesting or cancelling manual recovery does not start another migration", JSON.stringify(current), current.migration.state === "error" && current.automaticRetryAt === failed?.automaticRetryAt && draft.draftText.includes("Keep this draft"));
    await user.screenshot();
  });
  await step("confirmed manual recovery remains usable after the automatic attempt paused", async () => {
    await user.click({ role: "button", text: "Review upgrade" });
    await user.click({ role: "button", text: "Migrate chats" });
    await user.see({ testId: "engine-migration-consent" });
    await user.click({ role: "button", text: "Migrate chats" });
    const current = await probe.eventually(async () => upgradeStatus.parse((await probe.desktopApi("/experimental/engine-v2-preview/status")).body), {
      within: 20_000, label: "the user's manual attempt has its own failure receipt",
      until: value => value.migration.state === "error" && value.automaticRetryAt === undefined && value.migration.startedAt !== failed?.migration.startedAt,
    });
    await user.see({ testId: "engine-migration-progress" });
    await user.see({ role: "button", text: "Try again" });
    await user.notSee({ testId: "engine-migration-recovery" });
    evidence.recordAssertionEvidence("Manual consent starts a distinct attempt without automatically switching engines", JSON.stringify(current), !current.chatRouting && current.automaticRetryAt === undefined && current.migration.startedAt !== failed?.migration.startedAt);
    await user.screenshot();
    await user.click({ role: "button", text: "Close" });
    const draft = await probe.composer();
    expect(draft.draftText).toContain("Keep this draft while the upgrade is paused.");
  });
});
