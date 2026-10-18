import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { producedFileEvidence, producedFilePrompt } from "../worlds/produced-file-evidence.ts";

const test = spec.world(producedFileEvidence, {
  timeout: 300_000, resources: { surfaces: ["appWeb"], services: ["mock"] }, needs: { commands: ["bun"] },
});

test("a person finds a genuine workbook even when the assistant does not mention its path or use English file verbs", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("the agent returns a genuine workbook without a filename in its final reply", async () => {
    await user.type("composer", producedFilePrompt);
    await user.click("Run task");
    await user.see({ text: "Voilà. La feuille est prête." }, { timeoutMs: 120_000 });
    expect(await world.workbookSignature()).toBe("PK");
    await user.see({ role: "button", label: "Files (1)" }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("The output is discovered from the successful server write", "Actual XLSX signature PK; localized reply has no filename; Files (1)", (await world.workbookSignature()) === "PK");
    await user.screenshot();
  });
  await step("after: the workbook opens from Files with its actual values", async () => {
    await user.click({ role: "button", label: "Files (1)" });
    await user.see({ text: "budget.xlsx" });
    const cells = await probe.eventually(() => probe.dom('input[value="Total"]'), { within: 30_000, label: "the actual workbook cells", until: value => value.elements.length === 1 });
    expect(cells.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("The discovered output opens as a workbook, not raw tool JSON", "The displayed Summary sheet contains its Total cell", cells.elements.length === 1);
    await user.screenshot();
    await user.click("Close artifact");
  });
  await step("a plausible filename printed by a command is not promoted into another output", async () => {
    await user.see({ role: "button", label: "Files (1)" });
    await user.notSee({ role: "button", label: "Files (2)" });
    await user.notSee({ role: "tab", label: "not-produced.pdf" });
    const fileButtons = (await probe.dom('button[aria-label="Files (1)"]')).elements;
    expect(fileButtons).toHaveLength(1);
    evidence.recordAssertionEvidence("Only the genuinely produced file is available", "The reference-only command does not add not-produced.pdf; Files (1) after preview closes", fileButtons.length === 1);
    await user.screenshot();
  });
});
