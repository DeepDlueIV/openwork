import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { newSessionComposerFocus } from "../worlds/new-session-composer-focus.ts";

const test = spec.world(newSessionComposerFocus, {
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  timeout: 420_000,
});

test("a person who sends the first message of a new session can type the next one without clicking the composer", async ({ world, user, probe, step, evidence }) => {
  const route = () => world.route();
  const composerFocus = async () => {
    const editors = (await probe.dom("[data-lexical-editor='true'][contenteditable='true']")).elements;
    return { editors: editors.length, focused: editors.some((editor) => editor.focused) };
  };
  let sessionId = "";

  await step("before: a new session opens on an empty composer", async () => {
    await user.click({ role: "button", label: "New task" });
    await user.see("composer", { editable: true, text: "" });
    await probe.eventually(() => probe.composer(), {
      within: 60_000, label: "the composer's model is ready", until: (state) => !state.modelUnavailable,
    });
    await user.screenshot();
  });

  await step("the person types the first message and sends it with Enter", async () => {
    await user.type("composer", world.prompt, { verify: true });
    await user.press("Enter");
    const path = await probe.eventually(route, {
      within: 60_000, label: "the created session opens", until: (value) => /\/session\/ses_[^/]+$/.test(value),
    });
    sessionId = path.split("/session/")[1] ?? "";
    await user.see({ text: world.reply }, { timeoutMs: 90_000 });
    evidence.recordAssertionEvidence("The first message opens its own session and is answered", `route ${path}; reply "${world.reply}" on screen`, true);
  });

  await step("after: the session's composer already has the keyboard", async () => {
    const focus = await probe.eventually(composerFocus, {
      within: 10_000, label: "the composer is focused after the session opens", until: (value) => value.focused,
    }).catch(async () => composerFocus());
    evidence.recordAssertionEvidence(
      "The composer is focused without a click",
      `${focus.editors} composer editor(s) on screen; focused: ${focus.focused}`,
      focus.focused,
    );
    expect(focus.focused).toBe(true);
    await user.screenshot();
  });

  await step("after: keys typed straight away land in the composer and send the follow-up", async () => {
    // Deliberately no click: each key goes to whatever already has focus.
    for (const key of world.followup) await user.press(key);
    await user.see("composer", { text: world.followup });
    await user.press("Enter");
    await user.see({ text: world.followupReply }, { timeoutMs: 90_000 });
    const state = await probe.composer();
    expect((await route()).endsWith(`/session/${sessionId}`)).toBe(true);
    expect(state.userMessageCount).toBe(2);
    evidence.recordAssertionEvidence(
      "A follow-up typed without clicking is sent in the same session",
      `"${world.followup}" typed key by key, reply "${world.followupReply}" on screen; ${state.userMessageCount} user messages in ${sessionId}`,
      state.userMessageCount === 2,
    );
    await user.screenshot();
  });
});
