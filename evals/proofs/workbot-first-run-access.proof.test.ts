import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotFirstRunAccess } from "../worlds/workbot-first-run-access.ts";

const test = spec.world(workbotFirstRunAccess, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member in a disabled workspace gets a real next action, while an enabled workspace stays usable", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: a disabled workspace only says Workbot is not on", async () => {
    await user.see({ text: "Workbot isn't on for your organization yet." });
    await user.notSee({ role: "link", label: "Choose another workspace" });
    evidence.recordAssertionEvidence("The old disabled screen has no workspace recovery", "Workbot is off; no workspace-choice action", (await probe.dom('[data-testid="workbot-workspace-access"]')).elements.length === 0);
    await user.screenshot();
  });
  await step("after: the member can choose another workspace and knows who can enable this one", async () => {
    await user.navigate(world.url);
    await user.see({ role: "heading", label: "Workbot is off for Example workspace" });
    await user.see({ text: "Ask your workspace owner or platform administrator to turn on Workbot for this workspace." });
    await user.see({ role: "link", label: "Choose another workspace" });
    await user.notSee({ role: "link", label: "Open workspace feature settings" });
    const action = await probe.dom('a[href="/auth/login?workspace=choose"]');
    evidence.recordAssertionEvidence("The member gets workspace choice, not an inaccessible admin control", "Choose another workspace points to Workbot's real sign-in route", action.elements.length === 1);
    await user.screenshot();
  });
  await step("a platform administrator gets the actual workspace feature settings", async () => {
    await user.navigate(`${world.url}?admin=true`);
    await user.see({ role: "link", label: "Open workspace feature settings" });
    const action = await probe.dom('a[href="https://workspace.example.test/admin/organizations/org_example/features"]');
    evidence.recordAssertionEvidence("The administrator can reach the real rollout page", "The primary action names this workspace's feature settings", action.elements.length === 1);
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.screenshot();
  });
  await step("an enabled workspace opens chat instead of the disabled screen", async () => {
    await user.navigate(`${world.url}?enabled=true`);
    await user.click({ role: "button", label: "Get started" });
    await user.see({ role: "textbox", label: "Message Workbot" });
    await user.notSee({ testId: "workbot-workspace-access" });
    expect((await probe.dom('[data-testid="workbot-workspace-access"]')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Enabled workspaces never show disabled recovery", "The message composer is present; the workspace-access panel is absent", (await probe.dom('textarea[aria-label="Message Workbot"]')).elements.length === 1);
    await user.screenshot();
  });
});
