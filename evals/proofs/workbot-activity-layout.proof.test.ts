import { expect, spec } from "@openwork/testkit";
import { workbotActivity } from "../worlds/workbot-activity.ts";

const test = spec.world(workbotActivity, { timeout: 60_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member sees real command milestones without a jumping or artificially held activity line", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("the member requests a report with three measured command milestones", async () => {
    await user.see({ text: "The report has three sections." });
    await user.type({ role: "textbox", label: "Message Workbot" }, "Check progress");
    await user.press("Enter");
    await user.see({ text: "Checking section 1" });
    evidence.recordAssertionEvidence("The real activity card comes from the first command", `Runner stage ${world.progressStage()}; one new message POST`, world.progressStage() > 0 && world.sends() === 1);
    await user.screenshot();
  });
  await step("after: command boundaries hold the card and composer at fixed viewport positions", async () => {
    const samples: Array<{ stage: number; top: number; composerTop: number; height: number }> = [];
    await probe.eventually(async () => {
      const stage = world.progressStage();
      const cards = await probe.dom("[data-workbot-activity]");
      const composer = await probe.dom("[data-workbot-composer]");
      const card = cards.elements.at(-1);
      const input = composer.elements[0];
      if (card && input) samples.push({ stage, top: card.rect.top, composerTop: input.rect.top, height: card.rect.height });
      return stage;
    }, { within: 8000, label: "three commands settle without moving the card upward", until: stage => stage === 6 });
    const upwardJumps = samples.slice(1).filter((value, index) => value.top < (samples[index]?.top ?? value.top) - 1);
    const cardRange = Math.max(...samples.map(sample => sample.top)) - Math.min(...samples.map(sample => sample.top));
    const composerRange = Math.max(...samples.map(sample => sample.composerTop)) - Math.min(...samples.map(sample => sample.composerTop));
    expect(new Set(samples.map(sample => sample.stage)).size).toBeGreaterThanOrEqual(4);
    expect(upwardJumps).toHaveLength(0);
    expect(cardRange).toBeLessThanOrEqual(1);
    expect(composerRange).toBeLessThanOrEqual(1);
    evidence.recordAssertionEvidence("1280×900: zero upward activity jumps during three commands", JSON.stringify({ upwardJumps: upwardJumps.length, cardRange, composerRange, samples }), upwardJumps.length === 0 && cardRange <= 1 && composerRange <= 1);
    await user.screenshot();
  });
  await step("the failed final command ends honestly and the answer appears without simulated typing", async () => {
    await user.see({ text: "I couldn't verify every section." });
    await user.see({ text: "Computer work couldn't finish" });
    expect((await probe.dom(".workbot-worker, .workbot-typing-dot")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Failure is not converted to a success badge", "The full final answer is visible; computer work couldn't finish", (await probe.text()).includes("I couldn't verify every section."));
    await user.screenshot();
  });
});
