import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotWorkspace } from "../worlds/workbot-workspace.ts";

const test = spec.world(workbotWorkspace, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member opens and edits a Drive document while unavailable access stays blocked", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: Documents is locked while the feature is off", async () => {
    await user.navigate(`${world.url}documents?documents=off&assistant=off`);
    await user.see({ text: "Documents is off for your workspace. An admin can turn it on." });
    await user.notSee({ role: "textbox", label: "Document text" });
    evidence.recordAssertionEvidence("The feature starts off", "The locked state contains no document editor", (await probe.dom(".ow-editor-plain")).elements.length === 0);
    await user.screenshot();
  });
  await step("after: a connected member opens a recent Drive document in an editable tab", async () => {
    await user.navigate(`${world.url}documents?assistant=off`);
    await user.click({ role: "button", label: "Project brief.txt" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Project overview" });
    await user.type({ role: "textbox", label: "Document text" }, "Revised project overview", { replace: true });
    await user.see({ text: "Unsaved changes" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Revised project overview" });
    expect(world.messages()).toHaveLength(0);
    evidence.recordAssertionEvidence("Drive browsing and editing remain separate from chat", "The file opens as a tab and marks local changes without sending a message", world.messages().length === 0);
    await user.screenshot();
  });
  await step("a member without a Drive connection cannot see file content", async () => {
    await user.click({ role: "button", label: "Close Project brief.txt" });
    await user.click({ role: "button", label: "Discard changes" });
    await user.navigate(`${world.url}documents?access=denied&assistant=off`);
    await user.see({ text: "Connect Google Drive to browse and open your documents. Drive read permission is required." });
    await user.notSee({ role: "textbox", label: "Document text" });
    await user.see({ role: "link", label: "Connect Google Drive" });
    evidence.recordAssertionEvidence("The connection boundary hides the editor", "Drive sign-in is required before any document is opened", (await probe.dom(".ow-editor-plain")).elements.length === 0);
    await user.screenshot();
  });
});
