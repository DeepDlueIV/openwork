import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { lastTurnModelFooter } from "../worlds/last-turn-model-footer.ts";

const test = spec.world(lastTurnModelFooter, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun"] },
});

// Boundary proof only: these engines omit resolvedModel, so this does not prove
// the visible-model happy path. Component tests cover that path with verified metadata.
test("a member never sees a guessed model when the engine omits its resolved identity", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("before: completed answers remain readable when their model identity is unavailable", async () => {
    await user.reload();
    await user.see({ text: world.latest.reply });
    await user.see({ text: world.older.reply });
    await user.hover("composer");
    expect(world.repliesWithoutResolvedMetadata).toBe(2);
    expect(await world.featureEnabled()).toBe(false);
    await user.notSee({ testId: "reply-model" });
    evidence.recordAssertionEvidence("Both native replies lack a verified model identity", `completed replies=2; replies without resolved metadata=${world.repliesWithoutResolvedMetadata}; rollout=false; no model label`, world.repliesWithoutResolvedMetadata === 2);
    await user.screenshot();
  });

  await step("after: enabling the footer does not invent a model name for either answer", async () => {
    await world.setRollout(true);
    await user.reload();
    await user.see({ text: world.latest.reply });
    await user.hover("composer");
    expect(await world.featureEnabled()).toBe(true);
    await user.notSee({ testId: "reply-model" });
    const labels = (await probe.dom('[data-testid="reply-model"]')).elements;
    expect(labels).toHaveLength(0);
    evidence.recordAssertionEvidence("The enabled rollout preserves unknown provenance rather than guessing", `rollout=true; model labels=${labels.length}; both answers remain readable`, labels.length === 0);
    await user.screenshot();
  });

  await step("a narrow touch screen keeps the answer and actions without sideways scrolling", async () => {
    await world.touchInput();
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.see({ text: world.latest.reply });
    await user.see({ role: "button", label: "Branch in new chat", nth: 0 });
    await user.notSee({ testId: "reply-model" });
    const layout = await probe.dom('[data-message-role="assistant"]');
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    evidence.recordAssertionEvidence("The unknown-model fallback fits a touch screen", `viewport=${layout.viewportWidth}; document=${layout.documentWidth}; no guessed model label`, layout.documentWidth <= layout.viewportWidth);
    await user.screenshot();
  });

  await step("turning the rollout off preserves the same completed conversation", async () => {
    await world.setRollout(false);
    await user.reload();
    await user.see({ text: world.latest.reply });
    await user.see({ text: world.older.reply });
    const enabled = await world.featureEnabled();
    expect(enabled).toBe(false);
    await user.notSee({ testId: "reply-model" });
    evidence.recordAssertionEvidence("The rollout can be reverted without changing history", `rollout=${enabled}; both completed answers remain; no guessed model label`, !enabled);
    await user.screenshot();
  });
});
