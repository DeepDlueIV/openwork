import type { Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export async function teamAccess(seed: Seed) {
  const den = await seed.den({ web: true, env: { DEN_ORG_MODE: "multi_org", NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "" }, org: {
    name: `Access rows ${Date.now()}`, admin: { name: "Avery Owner" }, members: { teammate: { name: "Riley Teammate" }, outsider: { name: "Morgan Member" } },
  } });
  const outsider = den.members.outsider;
  if (!outsider) throw new Error("Missing outsider");
  const org = await seed.api(den.admin, "/v1/org");
  const organizationId = isRecord(org.body) && isRecord(org.body.organization) ? org.body.organization.id : null;
  const members = isRecord(org.body) ? records(org.body.members) : [];
  const teammate = members.find((member) => isRecord(member.user) && member.user.name === "Riley Teammate");
  if (typeof organizationId !== "string" || typeof teammate?.id !== "string") throw new Error("Missing organization or teammate");
  await enableOrganizationCapabilities(seed, den.admin, { teamRoles: true, sharedRoles: true }, organizationId);
  const id = (body: unknown) => { const item = isRecord(body) ? (isRecord(body.item) ? body.item : isRecord(body.team) ? body.team : null) : null; if (typeof item?.id !== "string") throw new Error(`Missing ID: ${JSON.stringify(body)}`); return item.id; };
  const call = async (path: string, body: unknown) => { const result = await seed.api(den.admin, path, { method: "POST", body: JSON.stringify(body) }); if (!result.response.ok) throw new Error(`${path}: ${result.response.status} ${result.text}`); return result.body; };
  const teamId = id(await call("/v1/teams", { name: "Research", memberIds: [teammate.id] }));
  const catalogId = id(await call("/v1/marketplaces", { name: "Shared tools" }));
  await call(`/v1/marketplaces/${catalogId}/access`, { teamId, role: "viewer" });
  const plugin = async (name: string, extra: Record<string, unknown> = {}) => id(await call("/v1/plugins", { name, orgWide: false, ...extra, components: [{ type: "skill", input: { rawSourceText: "---\nname: briefing\ndescription: Summarize synthetic notes.\n---\nSummarize the supplied notes." } }] }));
  const directId = await plugin("Research briefing");
  const directGrant = await call(`/v1/plugins/${directId}/access`, { teamId, role: "viewer" });
  await plugin("Company handbook", { orgWide: true });
  await plugin("Shared research tools for planning and reviewing unusually detailed project briefs", { marketplaceId: catalogId });
  const grants = await seed.api(den.admin, `/v1/teams/${teamId}/plugin-access`);
  const items = isRecord(grants.body) ? records(grants.body.items) : [];
  const grantId = items.find((item) => isRecord(item.plugin) && item.plugin.id === directId && item.edge === "direct_team")?.grantId;
  if (typeof grantId !== "string") throw new Error(`Missing direct grant: ${JSON.stringify(directGrant)}`);
  const startPath = `/dashboard/members/teams/${teamId}?tab=access`;
  const web = await seed.web({ den, signedInAs: den.admin, startPath, headless: true, viewport: { width: 1440, height: 1000 } });
  const member = await seed.web({ den, signedInAs: outsider, startPath: "/dashboard/library", headless: true, viewport: { width: 1440, height: 1000 } });
  return { den, web, member, teamId, directId, grantId, teamUrl: new URL(startPath, den.ref.webUrl).toString(),
    async setRows(enabled: boolean) { await enableOrganizationCapabilities(seed, den.admin, { teamAccessRows: enabled }, organizationId); },
    async outsiderRevoke() { return seed.api(outsider, `/v1/plugins/${directId}/access/${grantId}`, { method: "DELETE" }); },
    async access() { const result = await seed.api(den.admin, `/v1/teams/${teamId}/plugin-access`); return isRecord(result.body) ? records(result.body.items) : []; },
  };
}
