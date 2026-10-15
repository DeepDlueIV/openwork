import type { DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";

/**
 * Den Web with Team roles on (teamRoles, plus Permissions so custom roles
 * exist). One organization:
 *   - Olivia, the owner (also the deployment's platform admin),
 *   - Maya, in the Sales team (role Member),
 *   - Lee, in the Engineering team (custom role: share with everyone,
 *     create and remove marketplaces, import plugins from GitHub),
 *   - Nora, in no team.
 * Each person has their own signed-in browser.
 */

const ORGANIZATION_NAME = "Team roles workspace";

export const ENGINEERING_KEYS = ["sharing.share_org_wide", "marketplaces.manage", "plugins.import"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was missing from the Den response`);
  return value;
}

export async function teamRolesWorld(seed: Seed) {
  const stamp = Date.now().toString(36);
  const den = await seed.den({
    env: { DEN_PLAN_GATING_ENABLED: "false", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "" },
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Olivia Owner", email: `team-roles-owner+${stamp}@example.test` },
      members: {
        maya: { name: "Maya Member", email: `team-roles-maya+${stamp}@example.test` },
        lee: { name: "Lee Builder", email: `team-roles-lee+${stamp}@example.test` },
        nora: { name: "Nora Newcomer", email: `team-roles-nora+${stamp}@example.test` },
      },
    },
  });
  const owner = den.admin;
  const { maya, lee, nora } = den.members;
  if (!maya || !lee || !nora) throw new Error("The testkit did not provision every member session");

  const orgs = await seed.api(owner, "/v1/me/orgs");
  const orgList = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.filter(isRecord) : [];
  const orgId = text(orgList.find((org) => org.name === ORGANIZATION_NAME)?.id, "organization id");
  const scope = { "x-openwork-org-id": orgId };

  const flags = await seed.api(owner, `/v1/admin/organizations/${encodeURIComponent(orgId)}/capabilities`, {
    method: "PUT",
    body: JSON.stringify({ capabilities: { permissions: true, teamRoles: true } }),
  });
  if (!flags.response.ok) throw new Error(`Turning on Permissions and Team roles failed: HTTP ${flags.response.status} ${flags.text.slice(0, 300)}`);

  const roster = await seed.api(owner, "/v1/org", { headers: scope });
  const members = isRecord(roster.body) && Array.isArray(roster.body.members) ? roster.body.members.filter(isRecord) : [];
  const memberId = (session: DenSession) => text(
    members.find((member) => isRecord(member.user) && member.user.email === session.email)?.id,
    `member id for ${session.email}`,
  );
  const ids = { owner: memberId(owner), maya: memberId(maya), lee: memberId(lee), nora: memberId(nora) };

  const createTeam = async (name: string, memberIds: string[]) => {
    const created = await seed.api(owner, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name, memberIds }) });
    const team = isRecord(created.body) && isRecord(created.body.team) ? created.body.team : null;
    if (created.response.status !== 201 || !team) throw new Error(`Creating team ${name} failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
    return text(team.id, `${name} team id`);
  };
  const teams = { sales: await createTeam("Sales", [ids.maya]), engineering: await createTeam("Engineering", [ids.lee]) };

  const engineeringSet = await seed.api(owner, "/v1/permissions/sets", {
    method: "POST",
    headers: scope,
    body: JSON.stringify({ teamId: teams.engineering, permissions: ENGINEERING_KEYS.map((key) => ({ key, status: "allow" })) }),
  });
  if (engineeringSet.response.status !== 201) throw new Error(`Giving Engineering its custom role failed: HTTP ${engineeringSet.response.status} ${engineeringSet.text.slice(0, 300)}`);

  const viewport = { width: 1280, height: 900 };
  const ownerWeb = await seed.web({ den, signedInAs: owner, startPath: "/dashboard", headless: true, viewport });
  const noraWeb = await seed.web({ den, signedInAs: nora, startPath: "/dashboard", headless: true, viewport });

  return {
    den,
    orgId,
    owner,
    maya,
    lee,
    nora,
    ids,
    teams,
    ownerWeb,
    noraWeb,
    scope,
    /** Absolute Den Web URL for a dashboard path. */
    url(path: string): string {
      return new URL(path, den.ref.webUrl).toString();
    },
  };
}

export type TeamRolesWorld = Awaited<ReturnType<typeof teamRolesWorld>>;
