import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { workbotSharing } from "../worlds/workbot-sharing.ts";

const test = spec.world(workbotSharing, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member shares a Workbot link without granting team access", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: sharing is locked until a platform admin enables it", async () => {
    await user.click({ role: "button", label: "Share Workbot" });
    await user.see({ text: "Sharing is off. A platform admin can turn it on." });
    await user.notSee({ role: "button", label: "Copy Workbot link" });
    evidence.recordAssertionEvidence("No copy action is available before rollout", "The lock names the platform admin; no invitation request is sent", world.writes().length === 0);
    await user.screenshot();
  });
  await step("after: the member copies the current URL and sees that it does not grant access", async () => {
    await user.navigate(`${world.url}?sharing=on`);
    await user.type({ role: "textbox", label: "Message Workbot" }, "Keep this draft");
    await user.click({ role: "button", label: "Share Workbot" });
    await user.see({ text: "A link doesn't grant access. Ask your team admin to invite coworkers in Den." });
    await user.see({ role: "textbox", label: "Workbot link" }, { value: `${world.url}?sharing=on` });
    await user.click({ role: "button", label: "Copy Workbot link" });
    await user.see({ text: "Copied Workbot link" });
    const copied = await world.readClipboard();
    expect(copied).toBe(`${world.url}?sharing=on`);
    evidence.recordAssertionEvidence("Copying is reported only after the browser accepts it", "The clipboard holds the current URL; the coworker still needs an invitation", copied === `${world.url}?sharing=on` && world.writes().length === 0);
    await user.screenshot();
    await user.press("Escape");
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "Keep this draft" });
  });
  await step("a browser that blocks copying keeps the link available for manual copy", async () => {
    await user.navigate(`${world.url}?sharing=on&clipboard=blocked`);
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.click({ role: "button", label: "Share Workbot" });
    await user.click({ role: "button", label: "Copy Workbot link" });
    await user.see({ text: "Couldn't copy. Select the link above and copy it manually." });
    await user.notSee({ text: "Copied Workbot link" });
    const layout = await probe.dom('[data-base-ui-portal] input[aria-label="Workbot link"]');
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(world.writes()).toEqual([]);
    evidence.recordAssertionEvidence("Clipboard failure never claims success or creates an invitation", "The link stays on screen at mobile size; no writes were sent", world.writes().length === 0);
    await user.screenshot();
  });
});
