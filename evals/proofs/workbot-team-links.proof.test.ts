import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { workbotTeamLinks } from "../worlds/workbot-team-links.ts";

const test = spec.world(workbotTeamLinks, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("an authorized member opens team settings without leaving the conversation", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: an authorized member sees why team links are locked", async () => {
    await user.click({ role: "button", label: "Team settings" });
    await user.see({ text: "Team links are off. A platform admin can turn them on." });
    await user.notSee({ role: "link", label: /^Workbot settings/ });
    evidence.recordAssertionEvidence("Turning off the feature leaves no active admin link", "Authorized member sees the lock and its owner", (await probe.dom('[aria-disabled="true"]')).elements.length === 2);
    await user.screenshot();
  });
  await step("after: settings and app management open the token's workspace in a new tab", async () => {
    await user.navigate(`${world.url}?links=on`);
    await user.type({ role: "textbox", label: "Message Workbot" }, "Keep this draft");
    await user.click({ role: "button", label: "Team settings" });
    await user.see({ role: "link", label: /^Workbot settings/ });
    await user.see({ role: "link", label: /^Manage apps for your team/ });
    const links = await probe.dom('a[href*="workbotOrganizationId"][target="_blank"][rel~="noopener"]');
    expect(links.elements).toHaveLength(2);
    for (const page of ["workbot-settings", "mcp-connections"]) {
      expect((await probe.dom(`a[href="https://den.example.test/dashboard/${page}?workbotOrganizationId=org_linked"]`)).elements).toHaveLength(1);
    }
    evidence.recordAssertionEvidence("Both links preserve the exact organization and open separately", "Workbot settings and Manage apps for your team use org_linked, target=_blank and noopener", links.elements.length === 2);
    await user.screenshot();
    await user.press("Escape");
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "Keep this draft" });
  });
  await step("a member without team permissions sees no admin controls", async () => {
    await user.navigate(`${world.url}?links=on&persona=member`);
    await user.see({ role: "textbox", label: "Message Workbot" });
    await user.notSee({ role: "button", label: "Team settings" });
    evidence.recordAssertionEvidence("The non-admin has no actionable or locked admin entry", "Conversation remains usable; team settings control is absent", (await probe.dom('[aria-label="Team settings"]')).elements.length === 0);
    await user.screenshot();
  });
  await step("the team menu fits a narrow window and Escape returns focus", async () => {
    await user.navigate(`${world.url}?links=on`);
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.click({ role: "button", label: "Team settings" });
    await user.see({ role: "link", label: /^Manage apps for your team/ });
    const layout = await probe.dom('[data-base-ui-portal]');
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    evidence.recordAssertionEvidence("The menu is usable at mobile size", `Document width ${layout.documentWidth}; viewport ${layout.viewportWidth}`, layout.documentWidth <= layout.viewportWidth);
    await user.screenshot();
    await user.press("Escape");
    expect((await probe.dom('[aria-label="Team settings"]')).elements[0]?.focused).toBe(true);
  });
});
