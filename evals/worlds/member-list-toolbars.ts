import type { Seed } from "@openwork/env";
import { sharedRolesWorld } from "./shared-roles.ts";

export const LONG_INVITE_EMAIL = "a-very-long-email-only-person-for-the-members-list@example.test";
export const LONG_ROLE_NAME = "Publishing and organization operations with a very long custom role name";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function memberListToolbarsWorld(seed: Seed) {
  const world = await sharedRolesWorld(seed);
  const sets = await seed.api(world.owner, "/v1/permissions/sets", { headers: world.scope });
  const allSets = isRecord(sets.body) && Array.isArray(sets.body.sets) ? sets.body.sets.filter(isRecord) : [];
  const role = allSets.find((set) => set.kind === "team");
  const memberDefault = allSets.find((set) => set.kind === "member_default");
  if (typeof role?.id !== "string" || typeof memberDefault?.id !== "string") throw new Error("The role fixture is missing");
  // A read-only person can open Members through teams.view, but cannot invite,
  // edit members, create teams or read/manage custom roles.
  const readOnly = await seed.api(world.owner, `/v1/permissions/sets/${memberDefault.id}/permissions`, { method: "PUT", headers: world.scope, body: JSON.stringify({ changes: [{ key: "teams.view", status: "allow" }] }) });
  if (!readOnly.response.ok) throw new Error(`Could not grant read-only team access: ${readOnly.response.status}`);
  const renamed = await seed.api(world.owner, `/v1/permissions/sets/${role.id}`, { method: "PATCH", headers: world.scope, body: JSON.stringify({ name: LONG_ROLE_NAME }) });
  if (!renamed.response.ok) throw new Error(`Could not name the long custom role: ${renamed.response.status}`);
  const invited = await seed.api(world.owner, "/v1/invitations", {
    method: "POST", headers: world.scope,
    body: JSON.stringify({ email: LONG_INVITE_EMAIL, role: "member" }),
  });
  if (!invited.response.ok) throw new Error(`Could not seed email-only member: ${invited.response.status} ${invited.text.slice(0, 300)}`);
  return {
    ...world,
    async setToolbars(enabled: boolean) {
      const result = await seed.api(world.owner, `/v1/admin/organizations/${world.orgId}/capabilities`, {
        method: "PUT", body: JSON.stringify({ capabilities: { memberListToolbars: enabled } }),
      });
      if (!result.response.ok) throw new Error(`Could not enable list toolbars: ${result.response.status}`);
    },
  };
}
