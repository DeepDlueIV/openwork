import { denFetch, type DenFetchResult, type DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";

/**
 * One organization booted from the real migration chain, with:
 *   - the owner (also the deployment's platform admin, who turns features on),
 *   - Maya, a member of Research,
 *   - Tess, a member of Research and Design,
 *   - Nora, a member in no team,
 *   - one organization provider every member can use, with two models.
 * The Organization default model feature starts off, as it does everywhere.
 * All identities are synthetic example.test addresses.
 */

const ORGANIZATION_NAME = "Default model proof workspace";

export type DefaultModelCall = { status: number; body: unknown; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was missing from the Den response`);
  return value;
}

function call(result: DenFetchResult): DefaultModelCall {
  return { status: result.response.status, body: result.body, text: result.text };
}

export async function createOrgDefaultModelWorld(seed: Seed, options: { web?: boolean } = {}) {
  const stamp = Date.now().toString(36);
  const den = await seed.den({
    web: options.web ?? false,
    schema: "migrate",
    env: { DEN_PLAN_GATING_ENABLED: "false", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "" },
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Olivia Owner", email: `default-model-owner+${stamp}@example.test` },
      members: {
        maya: { name: "Maya Member", email: `default-model-maya+${stamp}@example.test` },
        tess: { name: "Tess Twoteams", email: `default-model-tess+${stamp}@example.test` },
        nora: { name: "Nora Noteam", email: `default-model-nora+${stamp}@example.test` },
      },
    },
  });
  const owner = den.admin;
  const { maya, tess, nora } = den.members;
  if (!maya || !tess || !nora) throw new Error("The testkit did not provision every member session");

  const orgs = await seed.api(owner, "/v1/me/orgs");
  const orgList = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.filter(isRecord) : [];
  const orgId = text(orgList.find((org) => org.name === ORGANIZATION_NAME)?.id, "organization id");
  const scope = { "x-openwork-org-id": orgId };

  const roster = await seed.api(owner, "/v1/org", { headers: scope });
  const members = isRecord(roster.body) && Array.isArray(roster.body.members) ? roster.body.members.filter(isRecord) : [];
  const memberId = (session: DenSession) => text(
    members.find((member) => isRecord(member.user) && member.user.email === session.email)?.id,
    `member id for ${session.email}`,
  );
  const ids = { maya: memberId(maya), tess: memberId(tess), nora: memberId(nora) };

  const createTeam = async (name: string, memberIds: string[]) => {
    const created = await seed.api(owner, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name, memberIds }) });
    const team = isRecord(created.body) && isRecord(created.body.team) ? created.body.team : null;
    if (created.response.status !== 201 || !team) throw new Error(`Creating team ${name} failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
    return text(team.id, `team id for ${name}`);
  };
  const teams = {
    research: await createTeam("Research", [ids.maya, ids.tess]),
    design: await createTeam("Design", [ids.tess]),
  };

  const provider = await seed.api(owner, "/v1/llm-providers", {
    method: "POST",
    headers: scope,
    body: JSON.stringify({
      name: "Example models",
      source: "custom",
      customConfig: {
        id: "default-model-eval-provider",
        name: "Example models",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:9/v1" },
        env: ["DEFAULT_MODEL_EVAL_PROVIDER_API_KEY"],
        models: [{ id: "model-a", name: "Model A" }, { id: "model-b", name: "Model B" }],
      },
      apiKey: "sk-openwork-default-model-eval-only",
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const llmProvider = isRecord(provider.body) && isRecord(provider.body.llmProvider) ? provider.body.llmProvider : null;
  if (provider.response.status !== 201 || !llmProvider) throw new Error(`Organization model setup failed: HTTP ${provider.response.status} ${provider.text.slice(0, 300)}`);
  const providerId = text(llmProvider.id, "organization provider id");

  return {
    den,
    orgId,
    owner,
    maya,
    tess,
    nora,
    ids,
    teams,
    providerId,
    /** One person's request to Den, scoped to this organization. */
    async request(session: DenSession, method: "GET" | "PUT", path: string, body?: unknown): Promise<DefaultModelCall> {
      return call(await denFetch(session, path, {
        method,
        headers: { authorization: `Bearer ${session.token}`, ...scope },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
    },
    /** A platform administrator turns an organization feature on or off from /admin. */
    async setFeature(key: string, enabled: boolean): Promise<DefaultModelCall> {
      return call(await denFetch(owner, `/v1/admin/organizations/${encodeURIComponent(orgId)}/capabilities`, {
        method: "PUT",
        headers: { authorization: `Bearer ${owner.token}` },
        body: JSON.stringify({ capabilities: { [key]: enabled } }),
      }));
    },
  };
}

export function orgDefaultModelWorld(seed: Seed) { return createOrgDefaultModelWorld(seed); }

export type OrgDefaultModelWorld = Awaited<ReturnType<typeof orgDefaultModelWorld>>;
