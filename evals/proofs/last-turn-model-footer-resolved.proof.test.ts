import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { lastTurnModelFooterResolved } from "../worlds/last-turn-model-footer-resolved.ts";

const test = spec.world(lastTurnModelFooterResolved, {
  timeout: 240_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
  needs: { commands: ["bun"] },
});

// Seeded native HTTP history, projected by the real app into verified reply metadata.
// This proves presentation, not that an inference provider reports its routed identity.
test("a member sees the last reply's verified model below the answer without repeating it above the work", async ({ world, user, probe, step, evidence }) => {
  const normal = `[data-session-surface-id="${world.normal.sessionId}"]`;
  const auto = `[data-session-surface-id="${world.auto.sessionId}"]`;
  const labels = async () => (await probe.dom(`${normal} [data-testid="reply-model"]`)).elements;
  const topLabels = async () => (await probe.dom(`${normal} [data-testid="completed-work-rail"] [data-testid="reply-model"]`)).elements;

  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("before: the disabled rollout names the verified model only above each answer", async () => {
    await user.click({ text: "Model footer" });
    await user.reload();
    await user.see({ text: world.latest.reply });
    await user.see({ text: world.older.reply });
    await user.hover("composer");
    const found = await probe.eventually(topLabels, { within: 15_000, label: "both original model labels", until: values => values.length === 2 });
    expect(await world.featureEnabled()).toBe(false);
    expect(world.fixtureReads).toBeGreaterThan(0);
    expect(await labels()).toHaveLength(2);
    expect(found.every(value => value.text.includes(world.modelName))).toBe(true);
    expect((await probe.dom(`${normal} [data-testid="reply-model"] .sr-only`)).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("The disabled rollout keeps both verified names above the answers", `top labels=${found.length}; footer labels=0; model=${world.modelName}`, found.length === 2);
    await user.screenshot();
  });

  await step("after: the latest answer keeps its model visible below the reply while actions stay quiet", async () => {
    await world.setRollout(true);
    await user.reload();
    await user.see({ text: world.latest.reply });
    await user.hover("composer");
    await probe.eventually(() => probe.dom(`${normal} [data-testid="reply-model"] .sr-only`), {
      within: 15_000, label: "both accessible footer prefixes", until: value => value.elements.length === 2,
    });
    await user.see({ testId: "reply-model", nth: 0 });
    await user.notSee({ testId: "reply-model", nth: 1 });
    await user.notSee({ testId: "reply-actions" });
    const found = await labels();
    expect(found.map(value => value.text)).toEqual([`Replied with ${world.modelName}`, `Replied with ${world.modelName}`]);
    expect(await topLabels()).toHaveLength(0);
    const answers = (await probe.dom(`${normal} [data-message-role="assistant"]`)).elements;
    expect(found[1]?.rect.top).toBeGreaterThanOrEqual(answers.at(-1)?.rect.bottom ?? Number.POSITIVE_INFINITY);
    const icons = (await probe.dom(`${normal} [data-testid="reply-model"] [aria-hidden="true"]`)).elements;
    expect(icons.every(icon => icon.rect.width === 12 && icon.rect.height === 12)).toBe(true);
    const rails = (await probe.dom(`${normal} [data-testid="completed-work-rail"]`)).elements;
    expect(rails.some(rail => rail.text.includes("5 steps"))).toBe(true);
    expect(rails.every(rail => !rail.text.includes(world.modelName))).toBe(true);
    evidence.recordAssertionEvidence("The latest verified model has one footer home and a fixed logo slot", `footers=${found.length}; visible at rest=1; top model labels=0; icon slots=${icons.length} at 12px`, found.length === 2 && icons.length === 2 && rails.every(rail => !rail.text.includes(world.modelName)));
    await user.screenshot();
  });

  await step("hovering the latest answer reveals its actions without moving the model", async () => {
    const before = (await labels())[1]?.rect;
    await user.hover({ text: world.latest.reply });
    await user.see({ testId: "reply-actions", nth: 0 });
    await user.notSee({ testId: "reply-actions", nth: 1 });
    const after = (await labels())[1]?.rect;
    expect(after?.left).toBe(before?.left);
    expect(after?.top).toBe(before?.top);
    evidence.recordAssertionEvidence("Hover changes action visibility, not model position", `before=${before?.left},${before?.top}; after=${after?.left},${after?.top}`, before?.left === after?.left && before?.top === after?.top);
    await user.screenshot();
  });

  await step("hovering an older answer reveals its model without repeating it in collapsed work", async () => {
    await user.hover({ text: world.older.reply });
    await user.see({ testId: "reply-model", nth: 1 });
    await user.see({ testId: "reply-actions", nth: 0 });
    const found = await labels();
    expect(found).toHaveLength(2);
    expect(await topLabels()).toHaveLength(0);
    evidence.recordAssertionEvidence("The older reply reveals its existing model footer", `visible model labels=2; total labels=${found.length}; model names in collapsed work=0`, found.length === 2);
    await user.screenshot();
  });

  await step("an Auto reply names its routed model once beside the OpenWork mark", async () => {
    await user.click({ text: "Auto reply" });
    await user.see({ text: world.autoReply.reply });
    await user.hover("composer");
    await user.see({ testId: "reply-model" });
    const found = (await probe.dom(`${auto} [data-testid="reply-model"]`)).elements;
    const marks = (await probe.dom(`${auto} [data-testid="reply-model"] svg[aria-label="OpenWork"]`)).elements;
    expect(found.map(value => value.text)).toEqual([`Replied with ${world.modelName}`]);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.rect.width).toBe(12);
    expect((await probe.dom(`${auto} [data-testid="completed-work-rail"] [data-testid="reply-model"]`)).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Auto retains the OpenWork mark and discloses only the routed reply name", `routed name=${world.modelName}; footer labels=${found.length}; OpenWork marks=${marks.length}`, found.length === 1 && marks.length === 1);
    await user.screenshot();
  });

  await step("a narrow touch screen keeps the model and actions visible without hover", async () => {
    await world.touchInput();
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.see({ text: world.autoReply.reply });
    await user.see({ testId: "reply-model" });
    await user.see({ testId: "reply-actions" });
    const layout = await probe.dom(`${auto} [data-testid="reply-model"]`);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.elements[0]?.rect.right).toBeLessThanOrEqual(layout.viewportWidth);
    evidence.recordAssertionEvidence("The model footer fits the narrow touch layout", `viewport=${layout.viewportWidth}; document=${layout.documentWidth}; model labels=${layout.elements.length}`, layout.documentWidth <= layout.viewportWidth && layout.elements.length === 1);
    await user.screenshot();
  });

  await step("turning the rollout off restores the original model placement without changing the reply", async () => {
    await world.setRollout(false);
    await user.reload();
    await user.see({ text: world.autoReply.reply });
    const found = await probe.eventually(() => probe.dom(`${auto} [data-testid="completed-work-rail"] [data-testid="reply-model"]`), {
      within: 15_000, label: "the restored Auto work-rail label", until: value => value.elements.length === 1,
    });
    expect((await probe.dom(`${auto} [data-testid="reply-model"] .sr-only`)).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Rollback restores the verified model above the same answer", `top labels=${found.elements.length}; footer prefixes=0; reply preserved`, found.elements.length === 1);
    await user.screenshot();
  });
});
