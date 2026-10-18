import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { appActivityEvidence, BUILD_PROMPT, GUIDE_PROMPT, SKILL_PROMPT } from "../worlds/app-activity-evidence.ts";

const test = spec.world(appActivityEvidence, { timeout: 240_000, resources: { surfaces: ["appWeb"], services: ["mock"] } });

test("a person sees failed App steps and saved results without invented progress", async ({ world, user, probe, step, evidence }) => {
  await step("after: unavailable instructions stay visible after the answer", async () => {
    await world.armFlicker();
    await user.type("composer", GUIDE_PROMPT);
    await user.click("Run task");
    await user.see({ text: "The instructions are unavailable; request access before retrying." }, { timeoutMs: 60_000 });
    const layout = await world.flicker();
    const rows = await probe.dom("[data-app-builder-failure]");
    evidence.recordAssertionEvidence("The failed instruction read remains outside disclosure", `${rows.elements.length} visible failure rows; layout upward jumps=${layout.upwardJumps}; positions=${layout.samples.join(",")}`, rows.elements.length > 0);
    await user.see({ text: "Needs attention" });
    expect(rows.elements.length).toBeGreaterThan(0);
    await user.notSee({ text: "Read the build guide" });
    await user.screenshot();
  });
  await step("after: a saved App survives the script failing later", async () => {
    await user.type("composer", BUILD_PROMPT);
    await user.click("Run task");
    await user.see({ text: "The project board was saved. The later script step failed." }, { timeoutMs: 60_000 });
    await user.see({ text: "App “Project board”" });
    await user.see({ text: /^Saved$/ });
    const saved = await world.savedMessages();
    const retained = saved.includes("openworkMcpResults") && saved.includes("ui://openwork/apps/") && saved.includes("Later script failure");
    evidence.recordAssertionEvidence("Native history retains the App receipt and the separate script failure", `delivery receipt=${saved.includes("openworkMcpResults")}; launch=${saved.includes("ui://openwork/apps/")}; script failure=${saved.includes("Later script failure")}`, retained);
    expect(retained).toBe(true);
    await user.notSee({ text: "Built and verified" });
    await user.notSee({ text: "Tools ready" });
    await user.screenshot();
  });
  await step("after: delivered instructions remain inspectable when the finished work folds", async () => {
    await user.type("composer", SKILL_PROMPT);
    await user.click("Run task");
    await user.see({ text: "All five report sections were checked." }, { timeoutMs: 60_000 });
    await user.see({ text: "Loaded “review” instructions" });
    const loaded = await probe.dom('[data-skill-evidence="instructions-loaded"]');
    const actual = (await world.toolCalls()).filter(call => call.name === "skill");
    evidence.recordAssertionEvidence("The loaded instruction receipt is visible beside the folded work", `${loaded.elements.length} visible receipts; ${actual.length} real retrieval calls`, loaded.elements.length > 0 && actual.length > 0);
    expect(loaded.elements.length).toBeGreaterThan(0);
    expect(actual.length).toBeGreaterThan(0);
    await user.notSee({ text: /Used your .* skill/ });
    await user.screenshot();
  });
  await step("after: reloading keeps the same saved App and instruction evidence", async () => {
    await user.reload();
    await user.see({ text: "App “Project board”" }, { timeoutMs: 30_000 });
    await user.see({ text: "Loaded “review” instructions" });
    const checklists = await probe.dom("[data-app-builder-checklist]");
    evidence.recordAssertionEvidence("History contains observed outcomes rather than inferred stage checkmarks", `${checklists.elements.length} inferred checklists after reload`, checklists.elements.length === 0);
    expect(checklists.elements).toHaveLength(0);
    await user.screenshot();
  });
});
