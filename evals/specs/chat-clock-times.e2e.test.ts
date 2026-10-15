import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { plainTimestampsChat, plainTimestampsLine, plainTimestampsMarker } from "../worlds/chat.ts";

const test = spec.world(plainTimestampsChat, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

test("clock times in an answer stay readable instead of turning into emoji", async ({ user, probe, step, evidence }) => {
  await step("given an answer that mentions 14:18:07 PDT and ends with :tada:", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    await user.type("composer", `When did the crash happen? ${plainTimestampsMarker}`);
    await user.click("Run task");
    await user.see({ text: "Found it" }, { timeoutMs: 120_000 });
  });

  await step("after: the times read as written and only the real shortcode becomes an emoji", async () => {
    const text = await probe.text();
    const timesKept = text.includes(plainTimestampsLine);
    const shortcodeRendered = text.includes("Found it 🎉") && !text.includes(":tada:");
    const noStrayEmoji = !text.includes("🔞");
    evidence.recordAssertionEvidence("Clock times are not read as emoji shortcodes",
      `times shown as written: ${timesKept}; 🔞 absent: ${noStrayEmoji}; ":tada:" shown as 🎉: ${shortcodeRendered}`,
      timesKept && noStrayEmoji && shortcodeRendered);
    expect(timesKept).toBe(true);
    expect(noStrayEmoji).toBe(true);
    expect(shortcodeRendered).toBe(true);
    await user.screenshot();
  });
});
