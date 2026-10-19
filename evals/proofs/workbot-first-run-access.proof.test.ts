import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotFirstRunAccess } from "../worlds/workbot-first-run-access.ts";

const test = spec.world(workbotFirstRunAccess, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a signed-in member opens generally available Workbot without an operator enabling their workspace", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: the member can start Workbot with the optional first-sign-in flow off", async () => {
    await user.see({ role: "button", label: "Get started" });
    await user.notSee({ text: "Workbot isn't on for your organization yet." });
    await user.notSee({ testId: "workbot-workspace-access" });
    evidence.recordAssertionEvidence("Workbot availability does not depend on the optional sign-in rollout", "Get started is available; no disabled-workspace panel", (await probe.dom('[data-testid="workbot-workspace-access"]')).elements.length === 0);
    await user.screenshot();
  });
  await step("after: the member opens chat without visiting feature settings", async () => {
    await user.click({ role: "button", label: "Get started" });
    await user.see({ role: "textbox", label: "Message Workbot" });
    const composer = await probe.dom('textarea[aria-label="Message Workbot"]');
    expect(composer.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("The signed-in member reaches chat directly", `message composers=${composer.elements.length}; no feature-setting action taken`, composer.elements.length === 1);
    await user.screenshot();
  });
  await step("an administrator sees the same available workspace rather than a retired enable action", async () => {
    await user.navigate(`${world.url}?admin=true`);
    await user.see({ role: "button", label: "Get started" });
    await user.click({ role: "button", label: "Get started" });
    await user.see({ role: "textbox", label: "Message Workbot" });
    await user.notSee({ role: "link", label: "Open workspace feature settings" });
    await user.notSee({ testId: "workbot-workspace-access" });
    const hidden = (await probe.dom('[data-testid="workbot-workspace-access"]')).elements.length === 0;
    evidence.recordAssertionEvidence("General availability never sends an administrator to a retired switch", "Chat is available; disabled-workspace panel and feature-setting link are absent", hidden);
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.screenshot();
  });
});
