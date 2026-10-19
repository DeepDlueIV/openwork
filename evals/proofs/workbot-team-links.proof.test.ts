import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { workbotTeamLinks } from "../worlds/workbot-team-links.ts";

const test = spec.world(workbotTeamLinks, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });
const teamPopup = '[data-testid="workbot-team-settings-popup"]';
const teamTrigger = 'button[aria-label="Team settings"]';

test("an authorized member opens team settings without leaving the conversation", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: an authorized member sees why team links are locked", async () => {
    await user.click({ role: "button", label: "Team settings" });
    await user.see({ text: "Team links are off. A platform admin can turn them on." });
    await user.notSee({ role: "link", label: /^Workbot settings/ });
    await user.notSee({ role: "link", label: /^Manage apps for your team/ });
    const popup = await probe.dom(teamPopup);
    const locked = await probe.dom(`${teamPopup} [aria-disabled="true"]`);
    const anchors = await probe.dom(`${teamPopup} a[href]`);
    const counts = {
      popups: popup.elements.length,
      lockedSettings: locked.elements.filter(row => row.text === "Workbot settings").length,
      lockedApps: locked.elements.filter(row => row.text === "Manage apps for your team").length,
      lockedRows: locked.elements.length,
      activeAnchors: anchors.elements.length,
    };
    const blocked = counts.popups === 1 && counts.lockedSettings === 1 && counts.lockedApps === 1 && counts.lockedRows === 2 && counts.activeAnchors === 0;
    evidence.recordAssertionEvidence("Turning off the feature leaves no active admin link", `Team settings popups: ${counts.popups}; locked Workbot settings: ${counts.lockedSettings}; locked Manage apps: ${counts.lockedApps}; total locked rows: ${counts.lockedRows}; active anchors: ${counts.activeAnchors}`, blocked);
    expect(counts).toEqual({ popups: 1, lockedSettings: 1, lockedApps: 1, lockedRows: 2, activeAnchors: 0 });
    await user.screenshot();
  });
  await step("after: settings and app management open the token's workspace in a new tab", async () => {
    await user.navigate(`${world.url}?links=on`);
    await user.type({ role: "textbox", label: "Message Workbot" }, "Keep this draft");
    await user.click({ role: "button", label: "Team settings" });
    await user.see({ role: "link", label: /^Workbot settings/ });
    await user.see({ role: "link", label: /^Manage apps for your team/ });
    const popup = await probe.dom(teamPopup);
    const locked = await probe.dom(`${teamPopup} [aria-disabled="true"]`);
    const anchors = await probe.dom(`${teamPopup} a[href]`);
    const newTabs = await probe.dom(`${teamPopup} a[href][target="_blank"][rel~="noopener"]`);
    const settings = await probe.dom(`${teamPopup} a[href="https://den.example.test/dashboard/workbot-settings?workbotOrganizationId=org_linked"]`);
    const apps = await probe.dom(`${teamPopup} a[href="https://den.example.test/dashboard/mcp-connections?workbotOrganizationId=org_linked"]`);
    const counts = { popups: popup.elements.length, lockedRows: locked.elements.length, activeAnchors: anchors.elements.length, newTabAnchors: newTabs.elements.length, settingsDestinations: settings.elements.length, appsDestinations: apps.elements.length };
    const correct = counts.popups === 1 && counts.lockedRows === 0 && counts.activeAnchors === 2 && counts.newTabAnchors === 2 && counts.settingsDestinations === 1 && counts.appsDestinations === 1;
    evidence.recordAssertionEvidence("Both links preserve the exact organization and open separately", `Team settings popups: ${counts.popups}; locked rows: ${counts.lockedRows}; active anchors: ${counts.activeAnchors}; new-tab/noopener anchors: ${counts.newTabAnchors}; exact org settings destinations: ${counts.settingsDestinations}; exact org app destinations: ${counts.appsDestinations}`, correct);
    expect(counts).toEqual({ popups: 1, lockedRows: 0, activeAnchors: 2, newTabAnchors: 2, settingsDestinations: 1, appsDestinations: 1 });
    await user.screenshot();
    await user.press("Escape");
    await probe.eventually(() => probe.dom(`${teamTrigger}, ${teamPopup}`), {
      within: 3000, label: "Escape closes the team popup and restores its trigger focus",
      until: snapshot => snapshot.elements.length === 1 && snapshot.elements[0]?.tag === "button" && snapshot.elements[0]?.focused === true,
    });
    await user.notSee({ testId: "workbot-team-settings-popup" });
    expect((await probe.dom(teamTrigger)).elements[0]?.focused).toBe(true);
    await user.see({ role: "textbox", label: "Message Workbot" }, { value: "Keep this draft" });
  });
  await step("a member without team permissions sees no admin controls", async () => {
    await user.navigate(`${world.url}?links=on&persona=member`);
    await user.see({ role: "textbox", label: "Message Workbot" });
    await user.notSee({ role: "button", label: "Team settings" });
    const triggers = await probe.dom(teamTrigger);
    const popup = await probe.dom(teamPopup);
    const links = await probe.dom('a[href*="/dashboard/workbot-settings"], a[href*="/dashboard/mcp-connections"]');
    const counts = { triggers: triggers.elements.length, popups: popup.elements.length, activeAdminAnchors: links.elements.length };
    const absent = counts.triggers === 0 && counts.popups === 0 && counts.activeAdminAnchors === 0;
    evidence.recordAssertionEvidence("The non-admin has no actionable or locked admin entry", `Team settings triggers: ${counts.triggers}; popups: ${counts.popups}; active admin anchors: ${counts.activeAdminAnchors}`, absent);
    expect(counts).toEqual({ triggers: 0, popups: 0, activeAdminAnchors: 0 });
    await user.screenshot();
  });
  await step("the team menu fits a narrow window and Escape returns focus", async () => {
    await user.navigate(`${world.url}?links=on`);
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.click({ role: "button", label: "Team settings" });
    await user.see({ role: "link", label: /^Manage apps for your team/ });
    const layout = await probe.dom(teamPopup);
    const locked = await probe.dom(`${teamPopup} [aria-disabled="true"]`);
    const anchors = await probe.dom(`${teamPopup} a[href]`);
    const popup = layout.elements[0];
    const counts = { popups: layout.elements.length, lockedRows: locked.elements.length, activeAnchors: anchors.elements.length };
    const fits = layout.documentWidth <= layout.viewportWidth && popup !== undefined && popup.rect.left >= 0 && popup.rect.right <= layout.viewportWidth;
    const usable = counts.popups === 1 && counts.lockedRows === 0 && counts.activeAnchors === 2 && fits;
    evidence.recordAssertionEvidence("The menu is usable at mobile size", `Team settings popups: ${counts.popups}; locked rows: ${counts.lockedRows}; active anchors: ${counts.activeAnchors}; document width: ${layout.documentWidth}; viewport width: ${layout.viewportWidth}; popup left: ${popup?.rect.left ?? "missing"}; popup right: ${popup?.rect.right ?? "missing"}`, usable);
    expect(counts).toEqual({ popups: 1, lockedRows: 0, activeAnchors: 2 });
    expect(fits).toBe(true);
    await user.screenshot();
    await user.press("Escape");
    await probe.eventually(() => probe.dom(`${teamTrigger}, ${teamPopup}`), {
      within: 3000, label: "Escape closes the team popup and restores its trigger focus",
      until: snapshot => snapshot.elements.length === 1 && snapshot.elements[0]?.tag === "button" && snapshot.elements[0]?.focused === true,
    });
    await user.notSee({ testId: "workbot-team-settings-popup" });
    expect((await probe.dom(teamTrigger)).elements[0]?.focused).toBe(true);
  });
});
