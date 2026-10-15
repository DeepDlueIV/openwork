import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { memberCustomRolesWorld, multiTeamMemberCustomRolesWorld, lockedMemberCustomRolesWorld } from "../worlds/member-custom-roles.ts";

const test = spec.world(memberCustomRolesWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});
const multiTeamTest = spec.world(multiTeamMemberCustomRolesWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

const lockedTest = spec.world(lockedMemberCustomRolesWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object witness");
  return value;
}
function rows(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }

test("an admin: I want to invite someone straight into the Skill publisher role", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.ownerWeb);
  await step("before: the admin opens Add member with Member selected", async () => {
    await admin.navigate(world.url("/dashboard"));
    await admin.click({ role: "link", label: "Members" });
    await admin.click({ role: "button", label: "Add member" });
    await admin.see({ testId: "member-role-change" }, { text: "Member" });
    evidence.recordAssertionEvidence("The invitation starts as Member", "Role is Member; Team is separate", true);
    await admin.screenshot();
  });
  await step("every custom role appears by name in the searchable role picker", async () => {
    await admin.click({ testId: "member-role-change" });
    await admin.see({ role: "option", label: /Skill publisher/ }, { timeoutMs: 30_000 });
    await admin.see({ role: "option", label: /Unassigned publisher/ });
    evidence.recordAssertionEvidence("Member and Admin are followed by custom permission-set names", "Skill publisher and Unassigned publisher are listed", true);
    await admin.screenshot();
  });
  await step("the admin finds Skill publisher by searching its full role name", async () => {
    await admin.type({ placeholder: "Search roles" }, "Skill publisher");
    await admin.see({ role: "option", label: /Skill publisher/ });
    evidence.recordAssertionEvidence("The role can be found by its permission-set name", "Skill publisher is listed On Engineering", true);
    await admin.screenshot();
  });
  await step("a role without a team blocks the invite and links to its role page", async () => {
    await admin.type({ placeholder: "Search roles" }, "Unassigned publisher", { replace: true });
    await admin.click({ role: "option", label: /Unassigned publisher/ });
    await admin.see({ text: "Unassigned publisher isn’t on a team yet. Add it to a team first." });
    const disabled = await probe.on(world.ownerWeb).dom('button[type="submit"][disabled]');
    evidence.recordAssertionEvidence("A teamless role cannot send an invite", `${disabled.elements.length} disabled submit button`, disabled.elements.length === 1);
    expect(disabled.elements).toHaveLength(1);
    await admin.screenshot();
  });
  await step("after: choosing Skill publisher automatically joins Engineering and sends a Member invite", async () => {
    await admin.click({ testId: "member-role-change" });
    await admin.type({ placeholder: "Search roles" }, "Skill publisher");
    await admin.click({ role: "option", label: /Skill publisher/ });
    await admin.see({ text: "Joins Engineering" });
    await admin.type({ testId: "invite-email" }, world.nora.email);
    await admin.click({ role: "button", label: "Send invite" });
    await admin.see({ text: world.nora.email }, { timeoutMs: 30_000 });
    const result = await probe.api(world.owner, "/v1/org", { headers: world.scope });
    const invitation = rows(record(result.body).invitations).find((entry) => entry.email === world.nora.email && entry.status === "pending");
    const pending = rows(record(result.body).members).find((entry) => record(entry.user).email === world.nora.email);
    const team = rows(record(result.body).teams).find((entry) => entry.id === world.teams.engineering);
    const ok = invitation?.role === "member" && pending?.role === "member" && Array.isArray(team?.memberIds) && team.memberIds.includes(pending.id);
    expect(ok).toBe(true);
    evidence.recordAssertionEvidence("The invitation atomically adds a pending Member to Engineering", `Role: ${String(invitation?.role)}; pending team membership: ${ok}`, ok);
    await admin.screenshot();
  });
  await step("the invited person accepts and receives Skill publisher through Engineering", async () => {
    const result = await probe.api(world.owner, "/v1/org", { headers: world.scope });
    const invitation = rows(record(result.body).invitations).find((entry) => entry.email === world.nora.email && entry.status === "pending");
    if (typeof invitation?.id !== "string") throw new Error("Missing pending invitation");
    // GET /v1/org never carries join tokens; the owner reads the link like Copy invite link does.
    const link = await probe.api(world.owner, `/v1/invitations/${invitation.id}/link`, { headers: world.scope });
    const inviteLink = record(link.body).inviteLink;
    if (!link.response.ok || typeof inviteLink !== "string") throw new Error(`Invite link: HTTP ${link.response.status}`);
    const invitee = user.on(world.noraWeb);
    await invitee.navigate(world.url(`/join-org?invite=${encodeURIComponent(new URL(inviteLink).searchParams.get("invite") ?? "")}`));
    await invitee.click({ role: "button", label: /^Join Team roles workspace$/ });
    await invitee.see({ text: "Download OpenWork" }, { timeoutMs: 60_000 });
    const joined = await probe.api(world.nora, "/v1/org", { headers: world.scope });
    const member = record(record(joined.body).currentMember);
    const roster = await probe.api(world.owner, "/v1/org", { headers: world.scope });
    const teams = rows(record(roster.body).teams);
    const engineering = teams.find((team) => team.id === world.teams.engineering);
    const ok = member.role === "member" && Array.isArray(member.permissions) && member.permissions.includes("sharing.share_org_wide") && Array.isArray(engineering?.memberIds) && engineering.memberIds.includes(member.id);
    evidence.recordAssertionEvidence("Acceptance applies the invitation's team", `Organization role ${String(member.role)}; Engineering membership and Share with everyone: ${ok}`, ok);
    expect(ok).toBe(true);
    await invitee.screenshot();
  });
  await step("Edit role uses the same picker and gives Maya Skill publisher without making her an Admin", async () => {
    await admin.click({ role: "button", label: "Open actions for Maya Member" });
    await admin.click({ role: "button", label: "Edit role" });
    await admin.click({ testId: "member-role-change" });
    await admin.type({ placeholder: "Search roles" }, "Skill publisher");
    await admin.click({ role: "option", label: /Skill publisher/ });
    await admin.see({ text: "Joins Engineering" });
    await admin.click({ testId: "member-role-save" });
    await probe.eventually(async () => (await probe.on(world.ownerWeb).dom('[data-testid="member-role-editor"]')).elements.length, {
      within: 30_000, label: "the member role is saved", until: (count) => count === 0,
    });
    await admin.notSee({ testId: "member-role-editor" });
    const result = await probe.api(world.maya, "/v1/org", { headers: world.scope });
    const member = record(record(result.body).currentMember);
    const ok = member.role === "member" && Array.isArray(member.permissions) && member.permissions.includes("sharing.share_org_wide");
    evidence.recordAssertionEvidence("Edit role adds the team, not organization Admin", `Maya organization role: ${String(member.role)}; publisher permission: ${ok}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });
});

test("a people coordinator without View permissions cannot discover custom roles", async ({ world, user, probe, step, evidence }) => {
  const coordinator = user.on(world.mayaWeb);
  const blockedEmail = `blocked-publisher+${Date.now().toString(36)}@example.test`;
  await step("the coordinator can invite people but cannot read permission sets", async () => {
    await coordinator.navigate(world.url("/dashboard"));
    await coordinator.click({ role: "link", label: "Members" });
    await coordinator.click({ role: "button", label: "Add member" });
    await coordinator.see({ testId: "member-role-change" });
    evidence.recordAssertionEvidence("Invite is available to the coordinator", "Add member opens the invite form", true);
    await coordinator.screenshot();
  });
  await step("the role picker contains Member and Admin but no custom role names", async () => {
    await coordinator.click({ testId: "member-role-change" });
    await coordinator.see({ role: "option", label: "Member" });
    await coordinator.notSee({ role: "option", label: /Skill publisher/ });
    evidence.recordAssertionEvidence("Custom role names stay private without View permissions", "Skill publisher is absent", true);
    await coordinator.screenshot();
  });
  await step("searching for a private custom role gives no matches", async () => {
    await coordinator.type({ placeholder: "Search roles" }, "Skill publisher");
    await coordinator.see({ text: "No roles match “Skill publisher”." });
    evidence.recordAssertionEvidence("Search does not reveal hidden permission-set names", "No roles match Skill publisher", true);
    await coordinator.screenshot();
  });
  await step("choosing a team cannot bypass the coordinator’s grant permissions", async () => {
    await coordinator.press("Escape");
    await coordinator.click({ role: "button", label: "Team" });
    await coordinator.click({ role: "option", label: /^Engineering/ });
    await coordinator.type({ testId: "invite-email" }, blockedEmail);
    await coordinator.click({ role: "button", label: "Send invite" });
    await coordinator.see({ text: "You can't add people to this team because it grants permissions you don't have." }, { timeoutMs: 30_000 });
    const result = await probe.api(world.owner, "/v1/org", { headers: world.scope });
    const absent = !rows(record(result.body).invitations).some((invitation) => invitation.email === blockedEmail);
    expect(absent).toBe(true);
    evidence.recordAssertionEvidence("The server refuses a team grant the coordinator does not hold", `Permission reason shown; no invitation saved: ${absent}`, absent);
    await coordinator.screenshot();
  });
});

test("an admin can use long role names on a phone-width screen without overflow", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.ownerPhone);
  await step("the admin opens the same role picker on a 390px screen", async () => {
    await admin.navigate(world.url("/dashboard/members"));
    await admin.click({ role: "button", label: "Add member" });
    await admin.click({ testId: "member-role-change" });
    await admin.see({ placeholder: "Search roles" });
    evidence.recordAssertionEvidence("The role menu is usable on a narrow screen", "Search roles is visible at 390px", true);
    await admin.screenshot();
  });
  await step("long names stay in one truncated row without widening the page", async () => {
    await admin.type({ placeholder: "Search roles" }, "Workspace compliance reviewer");
    await admin.see({ role: "option", label: new RegExp(world.longRoleName) });
    const page = await probe.on(world.ownerPhone).dom("html");
    const trigger = (await probe.on(world.ownerPhone).dom('[data-testid="member-role-change"]')).elements[0]?.rect;
    const popup = (await probe.on(world.ownerPhone).dom('[data-testid="member-role-choice"]')).elements[0]?.rect;
    const fits = page.documentWidth <= page.viewportWidth && Boolean(trigger && popup && Math.abs(trigger.width - popup.width) <= 1);
    expect(fits).toBe(true);
    evidence.recordAssertionEvidence("The long role menu stays trigger-width inside the viewport", `Page ${page.documentWidth}px; viewport ${page.viewportWidth}px; trigger ${trigger?.width}px; menu ${popup?.width}px`, fits);
    await admin.screenshot();
  });
  await step("Escape closes the menu and returns to the invitation without changing its role", async () => {
    await admin.press("Escape");
    await admin.notSee({ testId: "member-role-choice" });
    await admin.see({ testId: "member-role-change" }, { text: "Member" });
    evidence.recordAssertionEvidence("Dismissing the picker preserves Member", "Menu closed; role remains Member", true);
    await admin.screenshot();
  });
});

lockedTest("a coordinator can see custom roles but cannot grant permissions they do not hold", async ({ world, user, probe, step, evidence }) => {
  const coordinator = user.on(world.mayaWeb);
  await step("View permissions lets the coordinator see the same searchable role menu", async () => {
    await coordinator.navigate(world.url("/dashboard/members"));
    await coordinator.click({ role: "button", label: "Add member" });
    await coordinator.click({ testId: "member-role-change" });
    await coordinator.see({ role: "option", label: /Skill publisher/ });
    evidence.recordAssertionEvidence("Role visibility does not imply grant authority", "Skill publisher is visible in the picker", true);
    await coordinator.screenshot();
  });
  await step("Skill publisher stays locked with a reason naming the owner", async () => {
    await coordinator.type({ placeholder: "Search roles" }, "Skill publisher");
    await coordinator.see({ text: "This role grants permissions you don’t have. Ask the organization owner." });
    const locked = await probe.on(world.mayaWeb).dom(`button[data-testid="member-role-option-role:${world.publisherId}"][disabled]`);
    expect(locked.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("The coordinator cannot select the ungrantable role", `${locked.elements.length} disabled publisher option`, locked.elements.length === 1);
    await coordinator.screenshot();
  });
  await step("closing the locked role leaves the invitation as Member", async () => {
    await coordinator.press("Escape");
    await coordinator.see({ testId: "member-role-change" }, { text: "Member" });
    evidence.recordAssertionEvidence("No ungrantable selection is carried into the invite", "Role remains Member", true);
    await coordinator.screenshot();
  });
});

multiTeamTest("an admin chooses which team grants a shared role before sending an invite", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.ownerWeb);
  await step("Skill publisher appears once even though Engineering and Sales both carry it", async () => {
    await admin.navigate(world.url("/dashboard"));
    await admin.click({ role: "link", label: "Members" });
    await admin.click({ role: "button", label: "Add member" });
    await admin.click({ testId: "member-role-change" });
    await admin.type({ placeholder: "Search roles" }, "Skill publisher");
    await admin.see({ role: "option", label: /Skill publisher/ });
    const options = await probe.on(world.ownerWeb).dom('[role="option"]');
    expect(options.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("One shared role appears once", `${options.elements.length} matching option`, options.elements.length === 1);
    await admin.screenshot();
  });
  await step("the admin must choose one of that role’s teams", async () => {
    await admin.click({ role: "option", label: /Skill publisher/ });
    await admin.see({ role: "button", label: "Team" }, { text: "Choose a team" });
    const disabled = await probe.on(world.ownerWeb).dom('button[type="submit"][disabled]');
    expect(disabled.elements).toHaveLength(1);
    await admin.click({ role: "button", label: "Team" });
    await admin.see({ role: "option", label: "Sales" });
    await admin.see({ role: "option", label: "Engineering" });
    evidence.recordAssertionEvidence("The team choice is required and limited to the role's teams", "Sales and Engineering; Send invite disabled", disabled.elements.length === 1);
    await admin.screenshot();
  });
  await step("after: choosing Sales sends the invitation as Member", async () => {
    await admin.click({ role: "option", label: "Sales" });
    await admin.type({ testId: "invite-email" }, world.nora.email);
    await admin.click({ role: "button", label: "Send invite" });
    await admin.see({ text: world.nora.email }, { timeoutMs: 30_000 });
    const result = await probe.api(world.owner, "/v1/org", { headers: world.scope });
    const invitation = rows(record(result.body).invitations).find((entry) => entry.email === world.nora.email && entry.status === "pending");
    expect(invitation?.role).toBe("member");
    evidence.recordAssertionEvidence("A shared role does not promote the invitee to Admin", `Invitation role: ${String(invitation?.role)}`, invitation?.role === "member");
    await admin.screenshot();
  });
  await step("accepting joins only Sales, not every team that carries the role", async () => {
    const result = await probe.api(world.owner, "/v1/org", { headers: world.scope });
    const invitation = rows(record(result.body).invitations).find((entry) => entry.email === world.nora.email && entry.status === "pending");
    if (typeof invitation?.id !== "string") throw new Error("Missing pending invitation");
    // GET /v1/org never carries join tokens; the owner reads the link like Copy invite link does.
    const link = await probe.api(world.owner, `/v1/invitations/${invitation.id}/link`, { headers: world.scope });
    const inviteLink = record(link.body).inviteLink;
    if (!link.response.ok || typeof inviteLink !== "string") throw new Error(`Invite link: HTTP ${link.response.status}`);
    const invitee = user.on(world.noraWeb);
    await invitee.navigate(world.url(`/join-org?invite=${encodeURIComponent(new URL(inviteLink).searchParams.get("invite") ?? "")}`));
    await invitee.click({ role: "button", label: /^Join Team roles workspace$/ });
    await invitee.see({ text: "Download OpenWork" }, { timeoutMs: 60_000 });
    const joined = await probe.api(world.nora, "/v1/org", { headers: world.scope });
    const member = record(record(joined.body).currentMember);
    const roster = await probe.api(world.owner, "/v1/org", { headers: world.scope });
    const teams = rows(record(roster.body).teams);
    const contains = (id: string) => {
      const team = teams.find((entry) => entry.id === id);
      return Array.isArray(team?.memberIds) && team.memberIds.includes(member.id);
    };
    const ok = contains(world.teams.sales) && !contains(world.teams.engineering) && member.role === "member";
    evidence.recordAssertionEvidence("Acceptance applies exactly the selected team", `Sales: ${contains(world.teams.sales)}; Engineering: ${contains(world.teams.engineering)}; role: ${String(member.role)}`, ok);
    expect(ok).toBe(true);
    await invitee.screenshot();
  });
});
