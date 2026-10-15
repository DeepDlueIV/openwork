import type { Seed } from "@openwork/env";
import { sharedRolesWorld } from "./shared-roles.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value;
}

export async function memberCustomRolesWorld(seed: Seed) {
  const world = await sharedRolesWorld(seed);
  const sets = await seed.api(world.owner, "/v1/permissions/sets", { headers: world.scope });
  const list = record(sets.body).sets;
  const publisher = Array.isArray(list) ? list.map(record).find((set) => set.kind === "team") : null;
  if (!publisher || typeof publisher.id !== "string") throw new Error("Missing publisher role");
  const renamed = await seed.api(world.owner, `/v1/permissions/sets/${publisher.id}`, { method: "PATCH", headers: world.scope, body: JSON.stringify({ name: "Skill publisher" }) });
  if (!renamed.response.ok) throw new Error(`Rename role: ${renamed.text}`);
  const empty = await seed.api(world.owner, "/v1/permissions/sets", { method: "POST", headers: world.scope, body: JSON.stringify({ name: "Unassigned publisher", permissions: [] }) });
  if (!empty.response.ok) throw new Error(`Empty role: ${empty.text}`);
  const coordinator = await seed.api(world.owner, "/v1/permissions/sets", { method: "POST", headers: world.scope, body: JSON.stringify({ teamIds: [world.teams.sales], name: "People coordinator", permissions: ["invitations.manage", "members.update", "teams.manage"].map((key) => ({ key, status: "allow" })) }) });
  if (!coordinator.response.ok) throw new Error(`Coordinator role: ${coordinator.text}`);
  const removed = await seed.api(world.owner, `/v1/members/${world.ids.nora}`, { method: "DELETE", headers: world.scope });
  if (!removed.response.ok) throw new Error(`Remove future invitee: ${removed.text}`);
  const mayaWeb = await seed.web({ den: world.den, signedInAs: world.maya, startPath: "/dashboard", headless: true, viewport: { width: 1280, height: 900 } });
  const longRoleName = "Workspace compliance reviewer for every synthetic product and engineering department";
  const longRole = await seed.api(world.owner, "/v1/permissions/sets", { method: "POST", headers: world.scope, body: JSON.stringify({ name: longRoleName, permissions: [] }) });
  if (!longRole.response.ok) throw new Error(`Long role: ${longRole.text}`);
  const ownerPhone = await seed.web({ den: world.den, signedInAs: world.owner, startPath: "/dashboard", headless: true, viewport: { width: 390, height: 844 } });
  const coordinatorId = record(record(coordinator.body).set).id;
  if (typeof coordinatorId !== "string") throw new Error("Missing coordinator role id");
  return { ...world, publisherId: publisher.id, coordinatorId, mayaWeb, ownerPhone, longRoleName };
}

export async function lockedMemberCustomRolesWorld(seed: Seed) {
  const world = await memberCustomRolesWorld(seed);
  const permitted = await seed.api(world.owner, `/v1/permissions/sets/${world.coordinatorId}/permissions`, {
    method: "PUT", headers: world.scope, body: JSON.stringify({ changes: [{ key: "permissions.view", status: "allow" }] }),
  });
  if (!permitted.response.ok) throw new Error(`Allow role visibility: ${permitted.text}`);
  return world;
}

export async function multiTeamMemberCustomRolesWorld(seed: Seed) {
  const world = await memberCustomRolesWorld(seed);
  const linked = await seed.api(world.owner, `/v1/teams/${world.teams.sales}/permission-set`, {
    method: "PUT", headers: world.scope, body: JSON.stringify({ permissionSetId: world.publisherId }),
  });
  if (!linked.response.ok) throw new Error(`Share publisher role: ${linked.text}`);
  return world;
}
