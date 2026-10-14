import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { libraryListWide } from "../worlds/library-list-wide.ts";

const test = spec.world(libraryListWide, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
});

type Rect = { left: number; right: number; width: number };

/** Distinct left edges, rounded: one value means the column is a straight lane. */
function lanes(rects: Rect[]) {
  return [...new Set(rects.map((rect) => Math.round(rect.left)))];
}

test("a member reads the desktop Library as compact rows and can still open a skill and the add picker", async ({ world, user, agent, probe, step, evidence }) => {
  await step("after: descriptions sit under names and Ready is a state word, without non-numeric column headings", async () => {
    await user.resizeViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await agent.run("route.extensions.skills");
    await user.click({ role: "button", label: "All" });
    for (const name of world.skills) await user.see({ text: name }, { timeoutMs: 60_000 });
    await user.notSee({ role: "button", label: "Card view" });
    await user.notSee({ role: "button", label: "List view" });
    const rows = await probe.eventually(async () => (await probe.dom("[data-library-integrated-row]")).elements, {
      within: 60_000, label: "the Library lists every skill and server as compact rows", until: (items) => items.length >= world.skills.length + world.servers.length,
    });
    expect((await probe.dom("[data-library-columns]")).elements).toHaveLength(0);
    const description = (await probe.dom('[data-library-row="weekly-update"] [data-library-description]')).elements[0];
    const state = (await probe.dom('[data-library-row="weekly-update"] + [data-library-status]')).elements[0];
    expect(description?.text).toContain("Friday team update");
    expect(state?.text).toBe("Ready");
    expect(rows.every((row) => row.rect.height >= 44 && row.rect.height <= 52)).toBe(true);
    evidence.recordAssertionEvidence("the desktop uses the same row anatomy without Den chrome", `${rows.length} compact rows, each 44–52px; weekly-update shows its description and Ready; no column labels`, true);
    await user.screenshot();
  });

  await step("after: state and action lanes stay straight at wide and laptop sizes without sideways scrolling", async () => {
    for (const width of [2560, 1280, 900]) {
      await user.resizeViewport({ width, height: 900, deviceScaleFactor: 1 });
      const page = await probe.dom("[data-library-integrated-row]");
      const states = (await probe.dom("[data-library-integrated-row] > [data-library-status]")).elements;
      const actions = (await probe.dom("[data-library-action]")).elements;
      expect(page.documentWidth).toBeLessThanOrEqual(page.viewportWidth);
      expect(lanes(states.map((item) => item.rect))).toHaveLength(1);
      expect(lanes(actions.map((item) => item.rect))).toHaveLength(1);
      await user.screenshot();
    }
    evidence.recordAssertionEvidence("the compact lanes remain aligned as the window changes", "2560, 1280 and 900px windows: one state lane, one action lane, no horizontal document overflow", true);
  });

  await step("after: a skill shows its full steps and reveals its file only on request", async () => {
    const skill = world.skills[0];
    if (!skill) throw new Error("No skill was arranged.");
    await user.click({ text: skill });
    await probe.eventually(async () => (await probe.dom("[data-extension-detail-page]")).elements.length, {
      within: 10_000, label: "the skill detail replaces the list after its body loads", until: (count) => count === 1,
    });
    await user.see({ text: skill });
    expect((await probe.dom("[data-extension-detail-page]")).elements).toHaveLength(1);
    expect((await probe.dom("[data-library-detail-state]")).elements[0]?.text).toBe("Ready");
    expect((await probe.dom("[data-extension-detail-page] details[open]")).elements).toHaveLength(0);
    await user.see({ text: "Follow the description." });
    await user.screenshot();
    await user.click({ text: "Technical details" });
    await user.see({ text: /weekly-update\/SKILL\.md/ });
    evidence.recordAssertionEvidence("the detail presentation preserves the skill and its file", `${skill} has a readable Ready word and its original steps; the source file appears only after opening Technical details`, true);
    await user.screenshot();
  });

  await step("after: Add to library stays in the collection toolbar and opens the existing picker", async () => {
    await user.click({ role: "button", label: "Library" });
    await user.see({ role: "button", label: "Add to library" });
    await user.click({ role: "button", label: "Add to library" });
    await user.see({ role: "radio", label: /^Connector/ });
    await user.see({ role: "button", label: "Continue" });
    evidence.recordAssertionEvidence("the desktop add flow is unchanged", "The toolbar action opens Connector, Skill and Plugin choices with Continue", true);
    await user.screenshot();
  });
});
