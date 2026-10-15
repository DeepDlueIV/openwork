import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { DenSession } from "@openwork/behaviors";
import { ENGINEERING_KEYS } from "../worlds/team-roles.ts";
import { sharedRolesWorld, type SharedRolesWorld } from "../worlds/shared-roles.ts";

// Den Web Shared roles (sharedRoles, on top of teamRoles and permissions): a
// custom role is one permission set that any number of teams can have. The
// owner renames Engineering's role, gives it to Sales, picks another role for
// Sales from the team page, removes the role from a team with a confirm, and
// creates a role before any team has it. Each journey starts from the dashboard.
const test = spec.world(sharedRolesWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Probe = { api: (session: DenSession, path: string, init?: RequestInit) => Promise<{ body: unknown; response: Response }> };

async function permissionsOf(probe: Probe, world: SharedRolesWorld, session: DenSession): Promise<string[]> {
  const context = await probe.api(session, "/v1/org", { headers: world.scope });
  const current = isRecord(context.body) && isRecord(context.body.currentMember) ? context.body.currentMember : null;
  return Array.isArray(current?.permissions) ? current.permissions.filter((key): key is string => typeof key === "string") : [];
}

/** Each custom role by name, with the ids of the teams it is on. */
async function customRoles(probe: Probe, world: SharedRolesWorld): Promise<{ id: string; name: string; teamIds: string[] }[]> {
  const result = await probe.api(world.owner, "/v1/permissions/sets", { headers: world.scope });
  const sets = isRecord(result.body) && Array.isArray(result.body.sets) ? result.body.sets.filter(isRecord) : [];
  return sets.filter((set) => set.kind === "team").map((set) => ({
    id: String(set.id),
    name: String(set.name),
    teamIds: Array.isArray(set.teams) ? set.teams.filter(isRecord).map((team) => String(team.id)) : [],
  }));
}

test("an owner renames Engineering's role and gives the same role to Sales, and Maya in Sales gains it", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);

  await step("before: Maya, in Sales, can't share with everyone", async () => {
    const maya = await permissionsOf(probe, world, world.maya);
    const ok = !maya.includes("sharing.share_org_wide");
    evidence.recordAssertionEvidence("Maya holds no Engineering permission", `Maya holds ${maya.length} permissions`, ok);
    expect(ok).toBe(true);
  });

  await step("from the dashboard, the owner opens Members › Roles and the Engineering role, which lists its teams", async () => {
    await owner.navigate(world.url("/dashboard"));
    await owner.see({ role: "link", label: "Members" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Members" });
    await owner.see({ role: "tab", label: /^Roles/ }, { timeoutMs: 60_000 });
    await owner.click({ role: "tab", label: /^Roles/ });
    await owner.see({ testId: "role-row-custom" }, { text: /Engineering/, timeoutMs: 30_000 });
    await owner.click({ testId: "role-row-custom" });
    await owner.see({ testId: "role-teams" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "role-team-row" }, { text: /Engineering/ });
    evidence.recordAssertionEvidence("The role page opens on its teams", "Teams tab lists Engineering", true);
    await owner.screenshot();
  });

  await step("the owner names the role Publisher on its Permissions tab", async () => {
    await owner.click({ role: "tab", label: /^Permissions/ });
    await owner.type({ testId: "role-name" }, "Publisher", { replace: true });
    await owner.click({ testId: "role-name-save" });
    await owner.see({ testId: "den-toast" }, { text: /Renamed to Publisher/, timeoutMs: 30_000 });
    const renamed = (await customRoles(probe, world)).some((role) => role.name === "Publisher");
    evidence.recordAssertionEvidence("PATCH renames the permission set", `A custom role named Publisher exists: ${renamed}`, renamed);
    expect(renamed).toBe(true);
  });

  await step("after: the owner adds Sales on the Teams tab; Engineering and Sales now share one role", async () => {
    await owner.click({ role: "tab", label: /^Teams/ });
    await owner.click({ role: "button", label: "Add team" });
    await owner.see({ testId: "access-add-team-popover" }, { timeoutMs: 15_000 });
    await owner.click({ role: "option", label: /^Sales/ });
    await owner.click({ role: "button", label: "Add Sales" });
    await owner.see({ testId: "den-toast" }, { text: /Publisher given to Sales/, timeoutMs: 30_000 });
    await owner.see({ role: "button", label: /^Remove .* from Sales$/ });
    const role = (await customRoles(probe, world)).find((entry) => entry.name === "Publisher");
    const shared = Boolean(role && role.teamIds.includes(world.teams.sales) && role.teamIds.includes(world.teams.engineering));
    evidence.recordAssertionEvidence("One permission set is linked to two teams", `Publisher teams: ${role?.teamIds.join(", ") ?? "none"}`, shared);
    expect(shared).toBe(true);
    await owner.screenshot();
  });

  await step("boundary: Maya now holds every Engineering permission; Nora, in no team, holds none", async () => {
    const [maya, nora] = await Promise.all([permissionsOf(probe, world, world.maya), permissionsOf(probe, world, world.nora)]);
    const ok = ENGINEERING_KEYS.every((key) => maya.includes(key)) && !nora.includes("sharing.share_org_wide");
    evidence.recordAssertionEvidence("The shared role grants Sales members the same permissions", `Maya holds ${ENGINEERING_KEYS.filter((key) => maya.includes(key)).join(", ")}; Nora holds Share with everyone: ${nora.includes("sharing.share_org_wide")}`, ok);
    expect(ok).toBe(true);
  });
});

test("an owner removes the shared role from Engineering after a confirm; Sales keeps it", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);
  const engineeringRole = (await customRoles(probe, world))[0];
  if (!engineeringRole) throw new Error("The world's Engineering role is missing");

  await step("from the dashboard, the owner opens the Engineering role and gives it to Sales too", async () => {
    await owner.navigate(world.url("/dashboard"));
    await owner.see({ role: "link", label: "Members" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Members" });
    await owner.see({ role: "tab", label: /^Roles/ }, { timeoutMs: 60_000 });
    await owner.click({ role: "tab", label: /^Roles/ });
    await owner.click({ testId: "role-row-custom" });
    await owner.see({ testId: "role-teams" }, { timeoutMs: 60_000 });
    await owner.click({ role: "button", label: "Add team" });
    await owner.click({ role: "option", label: /^Sales/ });
    await owner.click({ role: "button", label: "Add Sales" });
    await owner.see({ role: "button", label: /^Remove .* from Sales$/ }, { timeoutMs: 30_000 });
  });

  await step("the owner clicks Remove on Engineering and is asked first", async () => {
    await owner.click({ role: "button", label: /^Remove .* from Engineering$/ });
    await owner.see({ testId: "role-team-remove-dialog" }, { text: /Sales keeps the role/, timeoutMs: 15_000 });
    evidence.recordAssertionEvidence("Removing a role from a team asks first and names who keeps it", "Dialog says Sales keeps the role", true);
    await owner.screenshot();
  });

  await step("after: Engineering loses the role, the role is not deleted, and Sales still has it", async () => {
    await owner.click({ testId: "role-team-remove-confirm" });
    // notSee fails on first sighting, so wait for the result before checking the dialog is gone.
    await owner.see({ testId: "den-toast" }, { text: /Removed .* from Engineering/, timeoutMs: 30_000 });
    await owner.notSee({ testId: "role-team-remove-dialog" });
    const role = (await customRoles(probe, world)).find((entry) => entry.id === engineeringRole.id);
    const ok = Boolean(role && role.teamIds.length === 1 && role.teamIds[0] === world.teams.sales);
    evidence.recordAssertionEvidence("Only the link to Engineering is removed", `Role teams now: ${role?.teamIds.join(", ") ?? "role deleted"}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("boundary: Lee, in Engineering, loses Share with everyone; Maya, in Sales, keeps it", async () => {
    const [lee, maya] = await Promise.all([permissionsOf(probe, world, world.lee), permissionsOf(probe, world, world.maya)]);
    const ok = !lee.includes("sharing.share_org_wide") && maya.includes("sharing.share_org_wide");
    evidence.recordAssertionEvidence("Removing from one team leaves the others", `Lee: ${lee.includes("sharing.share_org_wide")}; Maya: ${maya.includes("sharing.share_org_wide")}`, ok);
    expect(ok).toBe(true);
  });
});

test("an owner picks a role for Sales from every role on the team page, and creates a role before any team has it", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);

  await step("from the dashboard, the owner creates Billing viewer with no team", async () => {
    await owner.navigate(world.url("/dashboard"));
    await owner.see({ role: "link", label: "Members" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Members" });
    await owner.see({ role: "tab", label: /^Roles/ }, { timeoutMs: 60_000 });
    await owner.click({ role: "tab", label: /^Roles/ });
    await owner.click({ testId: "roles-create" });
    await owner.type({ testId: "role-new-name" }, "Billing viewer");
    await owner.click({ role: "switch", label: /^View billing$/ });
    await owner.click({ testId: "role-new-create" });
    await owner.see({ testId: "role-teams-empty" }, { timeoutMs: 60_000 });
    const role = (await customRoles(probe, world)).find((entry) => entry.name === "Billing viewer");
    const ok = Boolean(role && role.teamIds.length === 0);
    evidence.recordAssertionEvidence("A role can exist before any team has it", `Billing viewer teams: ${role ? role.teamIds.length : "missing"}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("the owner opens Members › Teams › Sales and Change role lists Member, Admin and every custom role", async () => {
    await owner.navigate(world.url("/dashboard"));
    await owner.click({ role: "link", label: "Members" });
    await owner.click({ role: "tab", label: /^Teams/ });
    await owner.click({ role: "link", label: "Sales" });
    await owner.see({ testId: "team-role-name" }, { text: "Member", timeoutMs: 60_000 });
    await owner.click({ testId: "team-role-change" });
    await owner.see({ testId: "team-role-choice" }, { timeoutMs: 15_000 });
    await owner.see({ role: "option", label: /^Billing viewer/ });
    await owner.see({ role: "option", label: /^Engineering/ });
    evidence.recordAssertionEvidence("Change role offers every role, not a generic Custom", "Billing viewer and Engineering's role are listed", true);
    await owner.screenshot();
  });

  await step("the team uses the same searchable trigger-width role picker as invitations and member editing", async () => {
    await owner.type({ placeholder: "Search roles" }, "Billing viewer");
    await owner.see({ role: "option", label: /^Billing viewer/ });
    const trigger = (await probe.on(world.ownerWeb).dom('[data-testid="team-role-change"]')).elements[0]?.rect;
    const popup = (await probe.on(world.ownerWeb).dom('[data-testid="team-role-choice"]')).elements[0]?.rect;
    const fits = Boolean(trigger && popup && Math.abs(trigger.width - popup.width) <= 1);
    expect(fits).toBe(true);
    evidence.recordAssertionEvidence("The shared searchable menu matches its team trigger width", `Trigger ${trigger?.width}px; menu ${popup?.width}px`, fits);
    await owner.screenshot();
  });

  await step("after: Sales is Billing viewer and Maya can view billing", async () => {
    await owner.click({ role: "option", label: /^Billing viewer/ });
    await owner.click({ testId: "team-role-save" });
    await owner.see({ testId: "team-role-name" }, { text: "Billing viewer", timeoutMs: 30_000 });
    await owner.see({ testId: "den-toast" }, { text: /Sales is now Billing viewer/ });
    const maya = await permissionsOf(probe, world, world.maya);
    const ok = maya.includes("billing.view");
    evidence.recordAssertionEvidence("The picked role applies to the team", `Maya holds View billing: ${ok}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });
});
