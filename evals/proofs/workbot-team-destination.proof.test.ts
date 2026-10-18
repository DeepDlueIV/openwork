import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { workbotTeamDestination } from "../worlds/workbot-team-destination.ts";

const test = spec.world(workbotTeamDestination, { timeout: 420_000, needs: { placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });

test("a team link opens its own workspace even when Den has another one active", async ({ world, user, probe, step, evidence }) => {
  await step("before: Den is showing the other workspace", async () => {
    await user.see({ testId: "workbot-settings-screen" }, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: /Other workspace/ });
    evidence.recordAssertionEvidence("The browser starts in the other workspace", "Other workspace is active before opening the explicit link", world.linkedId !== world.otherId);
    await user.screenshot();
  });
  await step("after: the Workbot link opens settings in the linked workspace", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/workbot-settings?workbotOrganizationId=${world.linkedId}`);
    await user.see({ role: "button", label: /Linked workspace/ }, { timeoutMs: 90_000 });
    await user.see({ testId: "workbot-settings-screen" });
    expect(await probe.url()).not.toContain("workbotOrganizationId");
    evidence.recordAssertionEvidence("The settings page belongs to the linked workspace", "Linked workspace is active; Workbot settings is visible; link hint was consumed", !(await probe.url()).includes("workbotOrganizationId"));
    await user.screenshot();
  });
  await step("the app management link also opens its own workspace", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections?workbotOrganizationId=${world.otherId}`);
    await user.see({ role: "button", label: /Other workspace/ }, { timeoutMs: 90_000 });
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections?workbotOrganizationId=${world.linkedId}`);
    await user.see({ role: "button", label: /Linked workspace/ }, { timeoutMs: 90_000 });
    await user.see({ role: "heading", label: "Connectors" });
    evidence.recordAssertionEvidence("App management uses the same exact workspace boundary", "Linked workspace is selected and its Connectors page is visible", !(await probe.url()).includes("workbotOrganizationId"));
    await user.screenshot();
  });
  await step("an unavailable workspace does not fall back to either member workspace", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/workbot-settings?workbotOrganizationId=org_unavailable`);
    await user.see({ text: "This Workbot workspace is unavailable. Open Workbot and check your team access." }, { timeoutMs: 90_000 });
    await user.notSee({ testId: "workbot-settings-screen" });
    evidence.recordAssertionEvidence("A forged workspace link fails closed", "Unavailable workspace message; no team's settings rendered", (await probe.dom('[data-testid="workbot-settings-screen"]')).elements.length === 0);
    await user.screenshot();
  });
});
