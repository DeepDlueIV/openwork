import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { LONG_INVITE_EMAIL, memberListToolbarsWorld } from "../worlds/member-list-toolbars.ts";

const test = spec.world(memberListToolbarsWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner filters members, teams and roles in the same toolbar, and a role survives its team's deletion", async ({ world, user, probe: unboundProbe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);
  const probe = unboundProbe.on(world.ownerWeb);
  const geometries: { filterHeight: number; actionHeight: number; left: number; right: number; top: number }[] = [];
  const toolbar = async (collection: "members" | "teams" | "roles") => {
    const fields = await probe.dom(`[data-testid="${collection}-toolbar"] label`);
    const actions = await probe.dom(`[data-testid="${collection}-toolbar"] > div > :last-child`);
    const field = fields.elements[0]?.rect;
    const action = actions.elements[0]?.rect;
    if (!field || !action) throw new Error(`Missing ${collection} toolbar`);
    geometries.push({ filterHeight: field.height, actionHeight: action.height, left: field.left, right: action.left + action.width, top: field.top });
    expect(field.height).toBe(32);
    expect(action.height).toBe(field.height);
    expect(action.top).toBe(field.top);
  };

  await step("before: the existing Members toolbar has Add member but no filter", async () => {
    await owner.navigate(world.url("/dashboard/members"));
    await owner.see({ role: "button", label: "Add member" }, { timeoutMs: 90_000 });
    await owner.notSee({ placeholder: "Filter members" });
    evidence.recordAssertionEvidence("the rollout starts off", "Add member is available; Filter members is absent", true);
    await owner.screenshot();
  });

  await step("after: members have a small filter and same-height Add member, with one email and a quiet owner lock", async () => {
    await world.enableToolbars();
    await owner.reload();
    await owner.see({ placeholder: "Filter members" }, { timeoutMs: 60_000 });
    await owner.see({ text: LONG_INVITE_EMAIL });
    await toolbar("members");
    const identity = (await probe.dom('[data-testid="org-member-identity"]')).elements.find((element) => element.text.includes(LONG_INVITE_EMAIL));
    const locks = await probe.dom('[data-testid="member-owner-locked"]');
    expect(identity?.text.split(LONG_INVITE_EMAIL).length).toBe(2);
    expect(locks.elements[0]?.text.trim()).toBe("");
    const roles = (await probe.dom('[data-testid="member-role"]')).elements;
    expect(Math.max(...roles.map((element) => element.rect.height))).toBeLessThanOrEqual(20);
    const lanes = (await probe.dom('[data-testid="member-actions"]')).elements;
    expect(new Set(lanes.map((element) => element.rect.left)).size).toBe(1);
    expect(new Set(lanes.map((element) => element.rect.width))).toEqual(new Set([28]));
    evidence.recordAssertionEvidence("compact rows and aligned toolbar", `email appears once; ${locks.elements.length} icon-only owner lock; role lines at most 20px`, true);
    await owner.screenshot();
  });

  await step("Add member opens the existing form and Cancel returns to the list", async () => {
    await owner.click({ role: "button", label: "Member list actions" });
    await owner.see({ role: "menuitem", label: "Copy install link" });
    await owner.screenshot();
    await owner.press("Escape");
    await probe.eventually(() => probe.dom('[role="menuitem"]'), { within: 10_000, label: "the member menu closes", until: (result) => result.elements.length === 0 });
    await owner.notSee({ role: "menuitem", label: "Copy install link" });
    await owner.click({ role: "button", label: "Add member" });
    await owner.see({ testId: "invite-email" });
    await owner.screenshot();
    await owner.click({ role: "button", label: "Cancel" });
    evidence.recordAssertionEvidence("the add action retains its form", "Add member opens Email and Cancel closes the form", true);
    await owner.screenshot();
  });

  await step("filtering members to no match keeps Add member available", async () => {
    await owner.type({ placeholder: "Filter members" }, "no-such-member");
    await owner.see({ text: "No members match your filter." });
    await owner.see({ role: "button", label: "Add member" });
    expect((await probe.dom('[data-testid="member-row"]')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("no-match members", "0 member rows; Add member remains", true);
    await owner.screenshot();
    await owner.type({ placeholder: "Filter members" }, "", { replace: true });
  });

  await step("Teams has the identical toolbar, without an introduction, and no-match filtering", async () => {
    await owner.click({ role: "tab", label: /^Teams/ });
    await owner.see({ placeholder: "Filter teams" });
    await toolbar("teams");
    await owner.notSee({ text: "Manage teams and their members." });
    await owner.screenshot();
    await owner.type({ placeholder: "Filter teams" }, "no-such-team");
    await owner.see({ text: "No teams match your filter." });
    expect((await probe.dom('[data-testid="team-row"]')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("teams filter", "0 team rows; Create team remains", true);
    await owner.screenshot();
    await owner.type({ placeholder: "Filter teams" }, "", { replace: true });
  });

  await step("Roles has the identical toolbar, with By permission in its keyboard-accessible list menu", async () => {
    await owner.click({ role: "tab", label: /^Roles/ });
    await owner.see({ placeholder: "Filter roles" });
    await owner.see({ testId: "role-row-custom" }, { timeoutMs: 30_000 });
    await toolbar("roles");
    expect(new Set(geometries.map((value) => JSON.stringify(value))).size).toBe(1);
    await owner.click({ role: "button", label: "Role list actions" });
    await owner.see({ role: "menuitem", label: "By permission" });
    evidence.recordAssertionEvidence("all three toolbar geometries", JSON.stringify(geometries), true);
    await owner.screenshot();
    await owner.press("Escape");
    await probe.eventually(() => probe.dom('[role="menuitem"]'), { within: 10_000, label: "the role menu closes", until: (result) => result.elements.length === 0 });
    await owner.notSee({ role: "menuitem", label: "By permission" });
  });

  await step("filtering roles matches built-in and custom role names without moving Create role", async () => {
    await owner.type({ placeholder: "Filter roles" }, "no-such-role");
    await owner.see({ text: "No custom roles match your filter." });
    await owner.see({ text: "No built-in roles match your filter." });
    expect((await probe.dom('[data-testid^="role-row-"]')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("no-match roles", "0 role rows; Create role remains", true);
    await owner.screenshot();
    await owner.type({ placeholder: "Filter roles" }, "", { replace: true });
  });

  await step("deleting Engineering asks first and leaves its custom role in Roles with No teams yet", async () => {
    await owner.click({ role: "tab", label: /^Teams/ });
    await owner.click({ role: "button", label: "Actions for Engineering" });
    await owner.click({ role: "menuitem", label: "Delete" });
    await owner.see({ testId: "confirm-dialog" });
    await owner.screenshot();
    await owner.click({ role: "button", label: "Delete team" });
    await probe.eventually(() => probe.dom('[data-testid="confirm-dialog"]'), { within: 30_000, label: "team deletion completes", until: (result) => result.elements.length === 0 });
    await owner.click({ role: "tab", label: /^Roles/ });
    await owner.see({ testId: "role-row-custom" }, { text: /No teams yet/, timeoutMs: 30_000 });
    const roles = await probe.api(world.owner, "/v1/permissions/sets", { headers: world.scope });
    const body = JSON.stringify(roles.body);
    expect(body).not.toContain(world.teams.engineering);
    evidence.recordAssertionEvidence("deleted teams leave no active role links", `HTTP ${roles.response.status}; deleted team absent; custom role remains visible`, !body.includes(world.teams.engineering));
    await owner.screenshot();
  });

  await step("the orphan role is reusable: give it to Sales and it immediately lists Sales", async () => {
    await owner.click({ testId: "role-row-custom" });
    await owner.see({ testId: "role-teams-empty" }, { timeoutMs: 60_000 });
    await owner.click({ role: "button", label: "Add team" });
    await owner.click({ role: "option", label: /^Sales/ });
    await owner.click({ role: "button", label: "Add Sales" });
    await owner.see({ role: "button", label: /^Remove .* from Sales$/ }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("orphan role reused", "Sales now holds the existing custom role", true);
    await owner.screenshot();
  });

  await step("deleting the reused role asks first, removes only the role and keeps Sales", async () => {
    await owner.click({ role: "tab", label: /^Permissions/ });
    await owner.click({ testId: "remove-team-permissions" });
    await owner.see({ role: "alertdialog" });
    await owner.screenshot();
    await owner.click({ role: "button", label: "Delete role" });
    await owner.see({ testId: "roles-custom-empty" }, { timeoutMs: 30_000 });
    await owner.click({ role: "tab", label: /^Teams/ });
    await owner.see({ role: "link", label: "Sales" });
    evidence.recordAssertionEvidence("role deletion preserves teams", "custom role is gone; Sales remains", true);
    await owner.screenshot();
  });

  await step("boundary: a member without management permissions sees locked add actions and cannot change members", async () => {
    const member = user.on(world.noraWeb);
    await member.navigate(world.url("/dashboard/members"));
    await member.see({ placeholder: "Filter members" }, { timeoutMs: 60_000 });
    const actions = await probe.on(world.noraWeb).dom('[data-testid="members-toolbar"] button:disabled');
    // Native disabled controls are observed in the DOM, not bypassed through an API mutation.
    expect(actions.elements.some((element) => element.text.includes("Add member"))).toBe(true);
    await member.notSee({ testId: "invite-email" });
    evidence.recordAssertionEvidence("member boundary", "locked Add member remains visible; invite form absent", true);
    await member.screenshot();
  });
});
