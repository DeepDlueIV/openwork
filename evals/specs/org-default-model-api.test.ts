import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { DenSession } from "@openwork/behaviors";
import { orgDefaultModelWorld, type DefaultModelCall, type OrgDefaultModelWorld } from "../worlds/org-default-model.ts";

// Organization default model (feature orgDefaultModel) at the Den API boundary.
// Off, nothing answers and desktops get no default model. On, an admin picks
// the organization default from the organization's own models and overrides it
// per team; each member's desktop config carries their effective model: their
// team's override, the organization default when they have none or when their
// teams disagree. Only OpenCode v2 desktops apply it (apps/app
// tests/org-default-model.test.ts covers that v1 ignores it).
const test = spec.world(orgDefaultModelWorld, {
  timeout: 600_000,
  resources: { surfaces: [], services: ["den"] },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function summary(result: DefaultModelCall): string {
  return `${result.status} ${result.text.slice(0, 300)}`;
}

async function desktopDefaultModel(world: OrgDefaultModelWorld, session: DenSession): Promise<unknown> {
  const config = await world.request(session, "GET", "/v1/me/desktop-config");
  expect(config.status, summary(config)).toBe(200);
  return field(config.body, "defaultModel");
}

function teamRow(settings: unknown, teamId: string): unknown {
  const teams = field(settings, "teams");
  return Array.isArray(teams) ? teams.find((team) => field(team, "teamId") === teamId) : undefined;
}

test("admins set an organization default model and per-team overrides; each member's desktop config carries their effective model, and nothing while the feature is off", { timeout: 600_000 }, async ({ world, step, evidence }) => {
  const modelA = { providerId: world.providerId, modelId: "model-a" };
  const modelB = { providerId: world.providerId, modelId: "model-b" };

  await step("with the feature off, the routes answer 404 and desktops get no default model", async () => {
    const settings = await world.request(world.owner, "GET", "/v1/org/default-model");
    const save = await world.request(world.owner, "PUT", "/v1/org/default-model/everyone", { model: modelA });
    const config = await desktopDefaultModel(world, world.nora);
    evidence.recordAssertionEvidence("Feature off: invisible and inert", `GET → ${settings.status} ${String(field(settings.body, "error"))}; PUT → ${save.status}; desktop defaultModel ${JSON.stringify(config)}`, settings.status === 404 && save.status === 404 && config === undefined);
    expect(settings.status, summary(settings)).toBe(404);
    expect(settings.body).toMatchObject({ error: "feature_disabled", feature: "orgDefaultModel" });
    expect(save.status, summary(save)).toBe(404);
    expect(config).toBeUndefined();
  });

  await step("an admin turns it on and lists the organization's models", async () => {
    const enabled = await world.setFeature("orgDefaultModel", true);
    expect(enabled.status, summary(enabled)).toBe(200);
    const options = await world.request(world.owner, "GET", "/v1/org/default-model/options");
    const rawOptions = field(options.body, "options");
    const listed: unknown[] = Array.isArray(rawOptions) ? rawOptions : [];
    const ids = listed.filter((entry) => field(entry, "providerId") === world.providerId).map((entry) => String(field(entry, "modelId")));
    evidence.recordAssertionEvidence("GET /v1/org/default-model/options lists the organization provider's models", `HTTP ${options.status}; ${listed.length} options; provider models ${JSON.stringify(ids)}; unavailable ${JSON.stringify(field(options.body, "unavailableSources"))}`, options.status === 200 && ids.includes("model-a") && ids.includes("model-b"));
    expect(options.status, summary(options)).toBe(200);
    expect(ids).toEqual(expect.arrayContaining(["model-a", "model-b"]));
    expect(field(options.body, "unavailableSources")).toEqual([]);
  });

  await step("only models the organization has are accepted, and only by people who can manage models", async () => {
    const unknown = await world.request(world.owner, "PUT", "/v1/org/default-model/everyone", { model: { providerId: world.providerId, modelId: "not-a-model" } });
    const member = await world.request(world.maya, "PUT", "/v1/org/default-model/everyone", { model: modelA });
    expect(unknown.status, summary(unknown)).toBe(400);
    expect(unknown.body).toMatchObject({ error: "unknown_model" });
    expect(member.status, summary(member)).toBe(403);
  });

  await step("the organization default reaches a member in no team", async () => {
    const saved = await world.request(world.owner, "PUT", "/v1/org/default-model/everyone", { model: modelA });
    expect(saved.status, summary(saved)).toBe(200);
    expect(field(saved.body, "everyone")).toEqual(modelA);
    const nora = await desktopDefaultModel(world, world.nora);
    expect(nora).toEqual({ providerID: world.providerId, modelID: "model-a", source: "organization" });
  });

  await step("a team override replaces it for the team's members", async () => {
    const saved = await world.request(world.owner, "PUT", `/v1/org/default-model/teams/${world.teams.research}`, { model: modelB });
    expect(saved.status, summary(saved)).toBe(200);
    expect(field(teamRow(saved.body, world.teams.research), "model")).toEqual(modelB);
    expect(await desktopDefaultModel(world, world.maya)).toEqual({ providerID: world.providerId, modelID: "model-b", source: "team", teamName: "Research" });
    expect(await desktopDefaultModel(world, world.nora)).toEqual({ providerID: world.providerId, modelID: "model-a", source: "organization" });
  });

  await step("a member on two teams with different overrides starts on the organization default, and both teams count them", async () => {
    const saved = await world.request(world.owner, "PUT", `/v1/org/default-model/teams/${world.teams.design}`, { model: modelA });
    expect(saved.status, summary(saved)).toBe(200);
    // Research says B, Design says A: Tess gets the organization default (A), from the organization.
    expect(await desktopDefaultModel(world, world.tess)).toEqual({ providerID: world.providerId, modelID: "model-a", source: "organization" });
    expect(field(teamRow(saved.body, world.teams.research), "conflictingMemberCount")).toBe(1);
    expect(field(teamRow(saved.body, world.teams.design), "conflictingMemberCount")).toBe(1);
    evidence.recordAssertionEvidence("Conflicting team overrides fall back to the organization default", `Tess (Research=model-b, Design=model-a) → organization default model-a; conflictingMemberCount Research ${String(field(teamRow(saved.body, world.teams.research), "conflictingMemberCount"))}, Design ${String(field(teamRow(saved.body, world.teams.design), "conflictingMemberCount"))}`, true);
  });

  await step("clearing a team override sends its members back to the organization default", async () => {
    const cleared = await world.request(world.owner, "PUT", `/v1/org/default-model/teams/${world.teams.research}`, { model: null });
    expect(cleared.status, summary(cleared)).toBe(200);
    expect(field(teamRow(cleared.body, world.teams.research), "model")).toBeNull();
    expect(await desktopDefaultModel(world, world.maya)).toEqual({ providerID: world.providerId, modelID: "model-a", source: "organization" });
  });

  await step("turning the feature off again removes the default model from desktop configs", async () => {
    const disabled = await world.setFeature("orgDefaultModel", false);
    expect(disabled.status, summary(disabled)).toBe(200);
    expect(await desktopDefaultModel(world, world.nora)).toBeUndefined();
    expect(await desktopDefaultModel(world, world.tess)).toBeUndefined();
  });
});
