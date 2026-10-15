import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { emojiShortcodesChat, emojiShortcodesMarker, emojiShortcodesPlainLine, emojiShortcodesRendered } from "../worlds/chat.ts";

const test = spec.world(emojiShortcodesChat, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

test("emoji shortcodes show their GitHub emoji while words in colons stay text", async ({ user, probe, step, evidence }) => {
  await step("given an answer with :rocket: :fire: :white_check_mark: and the words :home: and :test:", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    await user.type("composer", `How did the release go? ${emojiShortcodesMarker}`);
    await user.click("Run task");
    await user.see({ text: "Shipped" }, { timeoutMs: 120_000 });
  });

  await step("after: real shortcodes become the matching emoji and plain words stay as written", async () => {
    const text = await probe.text();
    const rendered = text.includes(emojiShortcodesRendered);
    const plainKept = text.includes(emojiShortcodesPlainLine);
    evidence.recordAssertionEvidence("Only real shortcodes become emoji",
      `"Shipped 🚀 🔥 ✅" shown: ${rendered}; ":home:" and ":test:" kept as text: ${plainKept}`,
      rendered && plainKept);
    expect(rendered).toBe(true);
    expect(plainKept).toBe(true);
    await user.screenshot();
  });
});
