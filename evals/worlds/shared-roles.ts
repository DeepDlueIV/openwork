import type { Seed } from "@openwork/env";
import { teamRolesWorld } from "./team-roles.ts";

/**
 * The Team roles world with Shared roles on: Engineering's custom role (share
 * with everyone, create and remove marketplaces, import plugins from GitHub)
 * can be given to other teams, so Sales (Maya) can get the same role.
 */
export async function sharedRolesWorld(seed: Seed) {
  const world = await teamRolesWorld(seed);
  const flags = await seed.api(world.owner, `/v1/admin/organizations/${encodeURIComponent(world.orgId)}/capabilities`, {
    method: "PUT",
    body: JSON.stringify({ capabilities: { sharedRoles: true } }),
  });
  if (!flags.response.ok) throw new Error(`Turning on Shared roles failed: HTTP ${flags.response.status} ${flags.text.slice(0, 300)}`);
  return world;
}

export type SharedRolesWorld = Awaited<ReturnType<typeof sharedRolesWorld>>;
