import { allocateFreePort } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/**
 * The owner on the Contractors team's page, on a Den with the AI Gateway
 * deployed (its proxy points at a closed port: nothing here sends a request
 * through it). Agent permissions, Team roles and the default model are on;
 * Team page tabs are off until the journey turns them on.
 *
 *   - Riley is in Contractors, Morgan in Engineering.
 *   - Contractors may open only docs.example.com (Open websites set to Block,
 *     with that site always allowed) and asks before commands.
 *   - AI providers: Claude for Contractors, a shared one for everyone, and one
 *     only Engineering can use.
 *   - Spend limits: $20 a day for everyone; Contractors has its own
 *     $50 a day and $500 a month.
 */
export async function teamPageTabs(seed: Seed, { place }: { place: Place }) {
  const local = place.kind === "local";
  const gatewayUrl = `http://127.0.0.1:${await allocateFreePort()}`;
  const den = await seed.den({
    web: true,
    env: {
      DEN_ORG_MODE: "multi_org", GATEWAY_ENABLED: "true",
      ...(local ? { NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl } : {}),
      PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
    },
    org: {
      name: `Team Tabs ${Date.now()}`,
      admin: { name: "Avery Owner" },
      members: { riley: { name: "Riley Contractor" }, morgan: { name: "Morgan Engineer" } },
    },
  });
  const riley = den.members.riley;
  if (!riley) throw new Error("seed.den() did not provision Riley");
  const context = await seed.api(den.admin, "/v1/org");
  const organization = isRecord(context.body) && isRecord(context.body.organization) ? context.body.organization : null;
  if (!context.response.ok || typeof organization?.id !== "string") throw new Error(`Reading the organization failed: ${context.text.slice(0, 500)}`);
  const organizationId = organization.id;
  const scope = { "x-openwork-org-id": organizationId };
  const members = isRecord(context.body) ? records(context.body.members) : [];
  const memberId = (name: string) => {
    const id = members.find((member) => isRecord(member.user) && member.user.name === name)?.id;
    if (typeof id !== "string") throw new Error(`${name} is not a member of the organization`);
    return id;
  };
  await enableOrganizationCapabilities(seed, den.admin, { agentPermissions: true, teamRoles: true, orgDefaultModel: true }, organizationId);

  const createTeam = async (name: string, person: string) => {
    const team = await seed.api(den.admin, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name, memberIds: [memberId(person)] }) });
    const teamId = isRecord(team.body) && isRecord(team.body.team) ? team.body.team.id : null;
    if (!team.response.ok || typeof teamId !== "string") throw new Error(`Setting up ${name} failed: ${team.text.slice(0, 500)}`);
    return teamId;
  };
  const contractors = await createTeam("Contractors", "Riley Contractor");
  const engineering = await createTeam("Engineering", "Morgan Engineer");

  const permissions = await seed.api(den.admin, `/v1/agent-permissions/teams/${encodeURIComponent(contractors)}`, {
    method: "PUT", headers: scope,
    body: JSON.stringify({ settings: { websites: { decision: "deny", allow: ["docs.example.com"] }, commands: { decision: "ask" } } }),
  });
  if (!permissions.response.ok) throw new Error(`Saving Contractors' agent permissions failed: HTTP ${permissions.response.status} ${permissions.text.slice(0, 300)}`);

  const provider = async (name: string, providerId: string, modelId: string, audience: { allMembers: true } | { teamIds: string[] }) => {
    const created = await seed.api(den.admin, "/v1/inference-providers", {
      method: "POST", headers: scope,
      body: JSON.stringify({ name, providerId, modelIds: [modelId], credential: { kind: "api_key", secret: "team-page-tabs-eval-only" }, ...audience }),
    });
    if (created.response.status !== 201) throw new Error(`Adding ${name} failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
  };
  await provider("Claude for Contractors", "anthropic", "claude-sonnet-4-5", { teamIds: [contractors] });
  await provider("Shared OpenRouter", "openrouter", "openai/gpt-4o-mini", { allMembers: true });
  await provider("Engineering models", "openrouter", "openai/gpt-4.1", { teamIds: [engineering] });

  const limit = async (name: string, limits: { timeframe: "day" | "month"; costUsd: string }[], target: { organization: true } | { teamId: string }) => {
    const created = await seed.api(den.admin, "/v1/gateway/usage-limit-policies", {
      method: "POST", headers: scope, body: JSON.stringify({ name, hardLimit: true, allowRequestReset: true, limits }),
    });
    const id = isRecord(created.body) ? created.body.id : null;
    if (created.response.status !== 200 || typeof id !== "string") throw new Error(`Adding the ${name} limit failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
    const assigned = await seed.api(den.admin, `/v1/gateway/usage-limit-policies/${encodeURIComponent(id)}/assignments`, { method: "POST", headers: scope, body: JSON.stringify(target) });
    if (assigned.response.status !== 200) throw new Error(`Applying the ${name} limit failed: HTTP ${assigned.response.status} ${assigned.text.slice(0, 300)}`);
    return id;
  };
  await limit("Everyone default", [{ timeframe: "day", costUsd: "20" }], { organization: true });
  const contractorsLimit = await limit("Contractors", [{ timeframe: "day", costUsd: "50" }, { timeframe: "month", costUsd: "500" }], { teamId: contractors });

  const teamPath = `/dashboard/members/teams/${encodeURIComponent(contractors)}`;
  const web = await seed.web({ den, signedInAs: den.admin, startPath: `${teamPath}?tab=agents`, headless: true, viewport: { width: 1440, height: 1200 } });
  const url = (path: string) => new URL(path, den.ref.webUrl).toString();

  return {
    den,
    web,
    organizationId,
    contractors,
    contractorsLimit,
    teamUrl: (tab: string) => url(`${teamPath}?tab=${tab}`),
    everyoneUrl: (tab: string) => url(`/dashboard/members/teams/everyone?tab=${tab}`),
    /** A platform admin turns Team page tabs on, or back off, for the organization. */
    async setTabs(enabled: boolean) {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${encodeURIComponent(organizationId)}/capabilities`, {
        method: "PUT", body: JSON.stringify({ capabilities: { teamPageTabs: enabled } }),
      });
      if (!result.response.ok) throw new Error(`Setting Team page tabs ${enabled}: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
    },
    /** The website rules Riley's desktop app receives, as "effect resource (source)". */
    async rileyWebsiteRules(): Promise<string[]> {
      const config = await seed.api(riley, "/v1/me/desktop-config");
      if (!config.response.ok || !isRecord(config.body)) throw new Error(`Reading Riley's desktop config failed: HTTP ${config.response.status}`);
      const rules = isRecord(config.body.agentPermissions) ? records(config.body.agentPermissions.rules) : [];
      return rules.filter((rule) => rule.action === "webfetch").map((rule) => `${String(rule.effect)} ${String(rule.resource)} (${String(rule.source)})`);
    },
  };
}
