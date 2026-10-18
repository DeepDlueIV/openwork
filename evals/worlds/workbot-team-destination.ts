import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities, seededOrganizationId } from "./organization-capabilities.ts";

function organizationId(value: unknown): string {
  if (typeof value !== "object" || value === null || !("organization" in value)) throw new Error("Missing organization");
  const org = value.organization;
  if (typeof org !== "object" || org === null || !("id" in org) || typeof org.id !== "string") throw new Error("Missing organization ID");
  return org.id;
}

/** A real local Den, two member workspaces and a browser whose session currently selects the other workspace. */
export async function workbotTeamDestination(seed: Seed) {
  const den = await seed.den({ org: { name: "Linked workspace", admin: { name: "Workspace Owner" } } });
  const linkedId = await seededOrganizationId(seed, den.admin);
  if (!linkedId) throw new Error("No seeded workspace");
  await enableOrganizationCapabilities(seed, den.admin, { workbot: true, workbotTeamLinks: true }, linkedId);
  const other = await seed.api(den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: "Other workspace" }) });
  if (!other.response.ok) throw new Error(`Create other workspace: ${other.response.status}`);
  const otherId = organizationId(other.body);
  await enableOrganizationCapabilities(seed, den.admin, { workbot: true, workbotTeamLinks: true }, otherId);
  const active = await seed.api(den.admin, "/v1/me/active-organization", { method: "POST", body: JSON.stringify({ organizationId: otherId }) });
  if (!active.response.ok) throw new Error(`Select other workspace: ${active.response.status}`);
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/workbot-settings", headless: true, viewport: { width: 1440, height: 1000 } });
  return { den, web, linkedId, otherId };
}
