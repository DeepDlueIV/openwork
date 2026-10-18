import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { producedFileEvidence, producedFilePrompt, producedFileV2Evidence, producedFileV2PathFreeEvidence, producedFileV2Prompt } from "../worlds/produced-file-evidence.ts";

const pathFreeTest = spec.world(producedFileV2PathFreeEvidence, {
  timeout: 300_000, resources: { surfaces: ["appWeb"], services: ["mock"] }, needs: { commands: ["bun"] },
});

const nativeTest = spec.world(producedFileV2Evidence, {
  timeout: 300_000, resources: { surfaces: ["appWeb"], services: ["mock"] }, needs: { commands: ["bun"] },
});

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


nativeTest("a person on the native engine finds a shell-produced summary through its localized file reference", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("the native engine writes the requested summary and returns a localized reference", async () => {
    await user.type("composer", producedFileV2Prompt);
    await user.click("Run task");
    await user.see({ text: "Voilà. summary.md" }, { timeoutMs: 120_000 });
    expect(await world.summary()).toContain("The requested summary.");
    await user.see({ role: "button", label: "Files (1)" }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("The localized reference resolves to a real native-engine output", "Native shell wrote summary.md; localized bare reference and Files (1) visible", (await world.summary()).includes("The requested summary."));
    await user.screenshot();
  });
  await step("after: Files opens the summary rather than requiring English file verbs", async () => {
    await user.click({ role: "button", label: "Files (1)" });
    await user.see({ text: "The requested summary." }, { timeoutMs: 30_000 });
    const text = await probe.text();
    expect(text).toContain("The requested summary.");
    evidence.recordAssertionEvidence("The native output opens in its normal document preview", "The requested summary is readable in the panel", text.includes("The requested summary."));
    await user.screenshot();
    await user.click("Close artifact");
  });
  await step("the real output survives reload while a printed filename never becomes a second artifact", async () => {
    await user.reload();
    await user.see({ role: "button", label: "Files (1)" }, { timeoutMs: 30_000 });
    await user.notSee({ role: "button", label: "Files (2)" });
    const buttons = (await probe.dom("button[aria-label=\"Files (1)\"]")).elements;
    expect(buttons).toHaveLength(1);
    evidence.recordAssertionEvidence("Native history keeps the one verified output", "Files (1) after reload; not-produced.pdf was only printed, not created", buttons.length === 1);
    await user.screenshot();
  });
});

// An explicit diagnostic of the remaining engine boundary. This test proves
// the gap rather than claiming that a path-free native shell write is fixed.
pathFreeTest("a path-free native shell result exposes the remaining discovery gap", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("the native shell really writes a summary but the assistant returns only Voilà", async () => {
    await user.type("composer", producedFileV2Prompt);
    await user.click("Run task");
    await user.see({ text: "Voilà." }, { timeoutMs: 120_000 });
    const summary = await world.summary();
    expect(summary).toContain("The requested summary.");
    evidence.recordAssertionEvidence("The path-free case has a real on-disk output", "summary.md exists with the requested contents, but the reply contains no filename or link", summary.includes("The requested summary."));
    await user.screenshot();
  });
  await step("the actual native history has tool and text results but no compatible file-change receipt", async () => {
    await user.see({ role: "button", label: "Files (0)" });
    const observed = await world.nativeEvidence();
    expect(observed.tools.length).toBeGreaterThan(0);
    expect(observed.contentTypes.every(type => ["text", "reasoning", "tool"].includes(String(type)))).toBe(true);
    const receiptKeys = observed.tools.flatMap(tool => tool.metadataKeys).filter(key => ["files", "producedFiles", "openworkProducedFiles"].includes(key));
    expect(receiptKeys).toEqual([]);
    evidence.recordAssertionEvidence("The unsupported discovery boundary is observed, not inferred from the command", JSON.stringify(observed), observed.tools.length > 0 && receiptKeys.length === 0);
    await user.screenshot();
  });
  await step("the missing discovery result stays unavailable instead of fabricating a file card", async () => {
    await user.click({ role: "button", label: "Files (0)" });
    await user.notSee({ text: "The requested summary." });
    const buttons = (await probe.dom('button[aria-label="Files (0)"]')).elements;
    expect(buttons).toHaveLength(1);
    evidence.recordAssertionEvidence("Path-free native shell discovery remains explicitly unresolved", "Files (0); no invented preview; the real summary still exists on disk", buttons.length === 1 && (await world.summary()).includes("The requested summary."));
    await user.screenshot();
  });
});
