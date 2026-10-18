import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { accessRolesWorld, accessRoleLookupFailure } from "../worlds/access-roles.ts";
import { record, rows } from "../worlds/org-invite.ts";

const test = spec.world(accessRolesWorld, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });
const lookupTest = spec.world(accessRoleLookupFailure, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner edits organization access separately from team roles, without demoting an Admin when a team write fails", async ({ world, user, probe, step, evidence }) => {
  await step("the owner opens the Admin's organization role without any team membership choices", async () => {
    await user.see({ text: "Direct Admin" }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Open actions for Direct Admin" });
    await user.click("Edit role");
    await user.click({ testId: "member-role-change" });
    await user.see({ role: "option", label: "Admin" });
    await user.notSee({ role: "option", label: /Publisher role/ });
    const choices = await probe.dom('[data-testid="member-role-choice"] [role="option"]');
    evidence.recordAssertionEvidence("organization role is independent of custom team roles", choices.elements.map((entry) => entry.text).join(", "), choices.elements.length === 2 && !choices.elements.some((entry) => entry.text.includes("Publisher role")));
    await user.screenshot();
    await user.press("Escape");
    await user.click({ role: "button", label: "Cancel" });
  });
  await step("a failed team membership change leaves the direct Admin role unchanged", async () => {
    await world.traffic.faults.status(world.faultPath(`/v1/teams/${world.beta}`), 503, { method: "PATCH", body: { error: "unavailable", message: "Team update unavailable" } });
    await user.click({ role: "button", label: "Open actions for Direct Admin" });
    await user.click({ role: "menuitem", label: "Manage teams" });
    await user.click({ role: "button", label: "Beta team" });
    await user.click({ role: "button", label: "Save teams" });
    await user.see({ text: "Team update unavailable" });
    const org = record((await probe.api(world.den.admin, "/v1/org")).body);
    const member = rows(org.members).find((entry) => entry.id === world.targetId);
    const team = rows(org.teams).find((entry) => entry.id === world.beta);
    const safe = member?.role === "admin" && Array.isArray(team?.memberIds) && !team.memberIds.includes(world.targetId);
    evidence.recordAssertionEvidence("no intermediate demotion", `direct role=${String(member?.role)}; failed team membership is absent=${safe}`, safe);
    expect(safe).toBe(true);
    await user.screenshot();
  });
  await step("a member without access is refused another person's permissions", async () => {
    const denied = await probe.api(world.den.members.plain, `/v1/members/${world.targetId}/permissions`);
    evidence.recordAssertionEvidence("private permission sources remain protected", `HTTP ${denied.response.status}; custom role leaked=${denied.text.includes("Publisher role")}`, denied.response.status === 403 && !denied.text.includes("Publisher role"));
    expect(denied.response.status).toBe(403);
  });
});

lookupTest("an owner cannot mistake a failed role lookup for Member or change an unverified role", async ({ world, user, probe, step, evidence }) => {
  await step("before: a failed lookup leaves the team's custom role unverified", async () => {
    await user.see({ text: "Role not verified" }, { timeoutMs: 90_000 });
    await user.see({ text: "Couldn't verify this team's role. Changes are blocked until verification succeeds." });
    const blocked = await probe.dom('[data-testid="team-role-change"]:disabled');
    evidence.recordAssertionEvidence("unknown is not Member", `disabled custom-role controls=${blocked.elements.length}`, blocked.elements.length === 1);
    expect(blocked.elements).toHaveLength(1);
    await user.screenshot();
  });
  await step("after: retry verifies the team in place and restores the role action", async () => {
    await user.click({ role: "button", label: "Try again" });
    await user.see({ text: "No custom role" });
    await user.click({ testId: "team-role-change" });
    await user.see({ role: "option", label: /Publisher role/ });
    const choices = await probe.dom('[data-testid="team-role-choice"] [role="option"]');
    evidence.recordAssertionEvidence("retry restores verified choices", choices.elements.map((entry) => entry.text).join(", "), choices.elements.some((entry) => entry.text.includes("Publisher role")));
    await user.screenshot();
  });
  await step("choosing a custom role keeps organization Admin access as its own grant", async () => {
    await user.click({ testId: `team-role-option-${world.publisher}` });
    await user.see({ text: /Organization Admin access stays on\./ });
    await user.click({ testId: "team-role-save" });
    await user.see({ testId: "team-role-name" }, { text: "Publisher role" });
    const org = record((await probe.api(world.den.admin, "/v1/org")).body);
    const admin = rows(org.teams).find((entry) => entry.id === world.alpha)?.grantsOrganizationAdmin;
    evidence.recordAssertionEvidence("custom assignment does not demote the team", `organization Admin access=${String(admin)}`, admin === true);
    expect(admin).toBe(true);
    await user.screenshot();
  });
});

test("an owner sees replacement consequences and retries only the teams whose role assignment failed", async ({ world, user, probe, step, evidence }) => {
  await step("the owner reviews which existing role each team will lose before assignment", async () => {
    await user.navigate(world.url(`/dashboard/permissions/${world.publisher}`));
    await user.click({ role: "button", label: "Assign role" });
    await user.click({ role: "option", label: /Alpha team/ });
    await user.click({ role: "option", label: /Beta team/ });
    await user.see({ text: "Beta team: Replaces Previous role" });
    await user.see({ text: "Alpha team: Adds this custom role; keeps organization Admin access" });
    const consequences = await probe.dom('[aria-label="Changes to review"]');
    const described = consequences.elements.map((entry) => entry.text).join("; ");
    evidence.recordAssertionEvidence("the replacement is visible before confirming", described, described.includes("Replaces Previous role") && described.includes("keeps organization Admin access"));
    await user.screenshot();
  });
  await step("one failed team stays selected, with both teams' actual outcomes retained", async () => {
    await world.traffic.faults.status(world.faultPath(`/v1/teams/${world.beta}/permission-set`), 503, { method: "PUT", body: { error: "unavailable", message: "Beta team unavailable" } });
    await user.click({ role: "button", label: "Assign role", nth: 1 });
    await user.see({ text: "Couldn't confirm the role for 1 team. Review the team results and retry only unconfirmed teams." });
    await user.press("Escape");
    const results = await probe.dom('[data-testid="role-assignment-result"]');
    evidence.recordAssertionEvidence("partial assignment names each outcome", results.elements.map((entry) => entry.text).join("; "), results.elements.some((entry) => entry.text.includes("Alpha team") && entry.text.includes("Role assigned")) && results.elements.some((entry) => entry.text.includes("Beta team unavailable")));
    expect(results.elements).toHaveLength(2);
    await user.screenshot();
  });
  await step("after: retry sends only the failed team and both roles are confirmed", async () => {
    await user.click({ role: "button", label: "Retry unconfirmed teams" });
    await probe.eventually(() => world.traffic.requestLog(), { within: 30_000, label: "failed team retried", until: (requests) => requests.filter((entry) => entry.method === "PUT" && entry.path.endsWith(`/${world.beta}/permission-set`)).length === 2 });
    const writes = (await world.traffic.requestLog()).filter((entry) => entry.method === "PUT" && entry.path.includes("/permission-set"));
    const alpha = writes.filter((entry) => entry.path.includes(world.alpha));
    const beta = writes.filter((entry) => entry.path.includes(world.beta));
    const results = await probe.eventually(() => probe.dom('[data-testid="role-assignment-result"]'), { within: 30_000, label: "both team outcomes confirmed", until: (result) => result.elements.length === 2 && result.elements.every((entry) => entry.text.includes("Role assigned")) });
    evidence.recordAssertionEvidence("retry does not replay successful writes", `Alpha writes=${alpha.length}; Beta writes=${beta.length}; confirmed teams=${results.elements.length}`, alpha.length === 1 && beta.length === 2);
    expect(alpha).toHaveLength(1);
    expect(beta).toHaveLength(2);
    await user.screenshot();
  });
});
