import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotWorkspace } from "../worlds/workbot-workspace.ts";

const test = spec.world(workbotWorkspace, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("Workbot offers a document it mentions and the conversation stays open beside it", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: opening a linked document from Home leaves the conversation behind", async () => {
    await user.navigate(`${world.url}?sideChats=on&chat=sidechat000000001`);
    await user.type({ role: "textbox", label: "Message Workbot" }, "Where are the budget notes?");
    await user.press("Enter");
    await user.see({ role: "link", label: "Budget notes", nth: 0 });
    await user.notSee({ testId: "workbot-document-offer" });
    await user.click({ role: "link", label: "Budget notes", nth: 0 });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Budget overview" });
    const chat = await probe.dom("[data-workbot-workspace-chat]");
    evidence.recordAssertionEvidence("Without guided navigation the chat collapses after opening", "Budget notes opened; no conversation beside it", chat.elements.length === 0);
    expect(chat.elements).toHaveLength(0);
    await user.screenshot();
  });
  await step("after: Workbot's Open action shows the document and keeps the same conversation open", async () => {
    await user.navigate(`${world.url}?guided=on&sideChats=on&chat=sidechat000000001`);
    await user.see({ role: "button", label: "Open Budget notes", nth: 0 });
    await user.click({ role: "button", label: "Open Budget notes", nth: 0 });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Budget overview" });
    const chat = await probe.eventually(() => probe.dom("[data-workbot-workspace-chat]"), { within: 3000, label: "the conversation opens beside the document", until: layout => layout.elements.length === 1 });
    await user.see({ testId: "workbot-view-context", text: /Budget notes\.txt · Read-only context/ });
    await user.see({ text: "Where are the budget notes?" });
    expect(await probe.url()).toContain("/documents");
    evidence.recordAssertionEvidence("The same conversation is open beside the opened document", "Earlier question visible in the floating chat; context chip names Budget notes.txt", chat.elements.length === 1);
    await user.screenshot();
  });
  await step("the next question carries the document the member is now looking at", async () => {
    const before = world.messages().length;
    await user.type({ role: "textbox", label: "Message Workbot" }, "What changed here?");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "the follow-up carries the opened document", until: values => values.length === before + 1 });
    expect(sent.at(-1)).toMatchObject({ text: "What changed here?", context: { kind: "document", fileId: "file_budget", title: "Budget notes.txt" } });
    evidence.recordAssertionEvidence("The follow-up refers to the document Workbot offered", JSON.stringify(sent.at(-1)), JSON.stringify(sent.at(-1)).includes("file_budget"));
    await user.screenshot();
  });
  await step("an offer the member cannot open does not replace the open document", async () => {
    await user.click({ role: "button", label: "Open Restricted document", nth: 0 });
    await user.see({ text: "Couldn't open this document. Check your Drive connection and access." });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Budget overview" });
    evidence.recordAssertionEvidence("Den still decides access when an offer is chosen", world.opened().join(","), !world.opened().includes("file_private"));
    await user.screenshot();
  });
});
