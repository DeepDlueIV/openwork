import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { chatCopy, draftPrompt, draftReply, formattedPrompt, formattedReply, scheduleFileName, type CopiedContent } from "../worlds/chat-copy.ts";

const test = spec.world(chatCopy, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

const describe = (copied: CopiedContent) => `rich text ${copied.outline.slice(0, 220)}; styled elements ${copied.styled.length ? copied.styled.slice(0, 3).join(", ") : "none"}; plain text ${JSON.stringify(copied.plain.slice(0, 160))}`;

test("a person copies a drafted email and a formatted answer out of a chat and gets the same paste whichever way they copy", async ({ world, user, step, evidence }) => {
  let copyButton: CopiedContent | undefined;

  await step("given an answer that reads the planting schedule and drafts an email as a quote", async () => {
    await user.type("composer", draftPrompt);
    await user.click("Run task");
    await user.see({ text: "Hi Alex," }, { timeoutMs: 120_000 });
    await user.see({ text: /^Jordan$|Best regards,\s*Jordan/ });
    await user.see({ text: new RegExp(scheduleFileName) });
    await user.screenshot();
  });

  await step("Copy puts the email on the clipboard as a quote, without the chat's grey italic styling", async () => {
    await user.hover({ text: "Hi Alex," });
    await user.click({ role: "button", label: "Copy message" });
    copyButton = await world.clipboard();
    const quoted = copyButton.outline.includes("<blockquote>");
    evidence.recordAssertionEvidence("Copy gives a quote and keeps the Markdown for plain-text editors", describe(copyButton), quoted && copyButton.styled.length === 0 && copyButton.plain === draftReply);
    expect(copyButton.plain).toBe(draftReply);
    expect(copyButton.outline).toContain("<blockquote>");
    expect(copyButton.styled).toEqual([]);
  });

  await step("selecting the email and pressing Cmd+C pastes the same quote", async () => {
    await user.select({ text: /^Hi Alex,[\s\S]*Jordan$/ });
    await user.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
    const selected = await world.clipboard();
    await user.screenshot();
    evidence.recordAssertionEvidence("Selecting and copying gives the same quote as Copy", describe(selected), selected.outline === copyButton?.outline && selected.styled.length === 0);
    expect(selected.plain).toContain("Hi Alex,");
    expect(selected.plain).toContain("Jordan");
    expect(selected.plain).not.toMatch(/^>/m);
    expect(selected.styled).toEqual([]);
    expect(selected.outline).toBe(copyButton?.outline);
  });

  await step("the sign-off keeps its two lines on screen and in both copies", async () => {
    await user.see({ text: "Best regards,\nJordan" });
    const selected = await world.clipboard();
    const twoLines = /Best regards,\n\s*Jordan/.test(selected.plain) && selected.outline.includes("Best regards,<br>Jordan");
    evidence.recordAssertionEvidence("The sign-off stays on two lines", `selected plain text ${JSON.stringify(selected.plain.slice(-40))}; rich text ${JSON.stringify(selected.outline.slice(-60))}`, twoLines);
    expect(selected.plain).toMatch(/Best regards,\n\s*Jordan/);
    expect(selected.outline).toContain("Best regards,<br>Jordan");
  });

  await step("the file name in the Read step can be selected and copied", async () => {
    await user.select({ text: new RegExp(`^Read\\s+${scheduleFileName.replace(".", "\\.")}`) });
    await user.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
    const copied = await world.clipboard();
    await user.screenshot();
    evidence.recordAssertionEvidence("The Read step copies with its file name", `plain text ${JSON.stringify(copied.plain)}`, copied.plain.includes(scheduleFileName));
    expect(copied.plain).toContain(scheduleFileName);
  });

  await step("given a formatted answer with a link, a list and a code block", async () => {
    await user.type("composer", formattedPrompt);
    await user.click("Run task");
    await user.see({ text: "Tell me if the schedule changes." }, { timeoutMs: 120_000 });
    await user.screenshot();
  });

  await step("Copy and selecting the whole answer paste the same document, without the code block's button labels", async () => {
    await user.hover({ text: "Tell me if the schedule changes." });
    await user.click({ role: "button", label: "Copy message" });
    const button = await world.clipboard();
    await user.select({ text: /^Here is the planting plan[\s\S]*Tell me if the schedule changes\.$/ });
    await user.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
    const selected = await world.clipboard();
    await user.screenshot();
    const same = selected.outline === button.outline;
    const chrome = /Copy code block|Enable word wrap/.test(selected.plain + selected.outline);
    evidence.recordAssertionEvidence("Both copies paste one document with the link, list and code", `Copy: ${describe(button)} | Selection: ${describe(selected)}`, same && !chrome && selected.styled.length === 0);
    expect(button.plain).toBe(formattedReply);
    expect(button.outline).toContain('<a href="https://example.com/seed-guide">the seed guide</a>');
    expect(button.outline).toContain("<li>Tomatoes on Monday</li>");
    expect(button.outline).toContain("water --zone garden --minutes 10");
    expect(selected.plain).not.toMatch(/Copy code block|Enable word wrap/);
    expect(selected.styled).toEqual([]);
    expect(selected.outline).toBe(button.outline);
  });
});
