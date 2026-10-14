import { localMysqlIsRunning, SkipError, type Place, type Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";

/**
 * Den web for the organization default model (feature orgDefaultModel), with
 * a real owner, two teams sharing a member, and no models until the spec adds
 * the organization's own provider, so the empty state is the real one. The
 * feature starts off, as it does everywhere. All identities are synthetic.
 */
export async function denOrgDefaultModel(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("Den web runs next to a local Den");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable openwork_eval_ database");
  const den = await seed.den({
    web: true,
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DEN_ORG_MODE: "multi_org",
      RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
    },
    org: {
      name: "Default model proof workspace",
      admin: { name: "Model Owner", email: "default-model-owner@example.test" },
      members: {
        maya: { name: "Maya Member", email: "default-model-maya@example.test" },
        tess: { name: "Tess Twoteams", email: "default-model-tess@example.test" },
      },
    },
  });
  const admin = den.admin;
  const context = await seed.api(admin, "/v1/org");
  const organization = isRecord(context.body) && isRecord(context.body.organization) ? context.body.organization : null;
  const orgId = typeof organization?.id === "string" ? organization.id : null;
  if (!orgId) throw new Error("The seeded organization is missing");
  const scope = { "x-openwork-org-id": orgId };
  const memberId = (email: string) => {
    const membership = isRecord(context.body)
      ? records(context.body.members).find((entry) => isRecord(entry.user) && entry.user.email === email)
      : undefined;
    if (typeof membership?.id !== "string") throw new Error(`The membership for ${email} is missing`);
    return membership.id;
  };
  const createTeam = async (name: string, memberIds: string[]) => {
    const created = await seed.api(admin, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name, memberIds }) });
    const id = isRecord(created.body) && isRecord(created.body.team) ? created.body.team.id : null;
    if (!created.response.ok || typeof id !== "string") throw new Error(`Could not create ${name}: ${created.text.slice(0, 300)}`);
    return id;
  };
  const maya = memberId("default-model-maya@example.test");
  const tess = memberId("default-model-tess@example.test");
  const teams = { research: await createTeam("Research", [maya, tess]), design: await createTeam("Design", [tess]) };

  const viewport = { width: 1440, height: 900 };
  const web = await seed.web({ den, signedInAs: admin, startPath: "/dashboard/org-settings", headless: true, viewport });

  return {
    den, web, orgId, teams,
    url: (path: string) => `${den.ref.webUrl}${path}`,
    /** A platform administrator turns the feature on or off for this organization from /admin. */
    async setFeature(enabled: boolean) {
      const result = await seed.api(admin, `/v1/admin/organizations/${orgId}/capabilities`, {
        method: "PUT", body: JSON.stringify({ capabilities: { orgDefaultModel: enabled } }),
      });
      if (!result.response.ok) throw new Error(`Turning orgDefaultModel ${enabled ? "on" : "off"} failed: ${result.text.slice(0, 300)}`);
    },
    /** The organization's own provider, used by every member, with a few models. */
    async addProvider(): Promise<string> {
      const created = await seed.api(admin, "/v1/llm-providers", {
        method: "POST",
        headers: scope,
        body: JSON.stringify({
          name: "Anthropic",
          source: "custom",
          customConfig: {
            id: "anthropic",
            name: "Anthropic",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://127.0.0.1:9/v1" },
            env: ["ANTHROPIC_API_KEY"],
            models: [
              { id: "claude-sonnet-example", name: "Claude Sonnet" },
              { id: "claude-opus-example", name: "Claude Opus" },
              { id: "claude-haiku-example", name: "Claude Haiku" },
            ],
          },
          apiKey: "sk-openwork-default-model-ui-eval-only",
          allMembers: true,
          memberIds: [],
          teamIds: [],
        }),
      });
      const provider = isRecord(created.body) && isRecord(created.body.llmProvider) ? created.body.llmProvider : null;
      if (created.response.status !== 201 || typeof provider?.id !== "string") throw new Error(`Could not add the provider: ${created.text.slice(0, 300)}`);
      return provider.id;
    },
  };
}
