import { expect } from "vitest";
import {
  findMyOrganizationId, freshSession, modelTelemetryEvent, provisionOrg, readOrganizationModelAnalytics,
  requestSignInHandoff, sendAppTelemetry, setApprovedWebOrigin,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { spec } from "@openwork/testkit";
import { orgModelAnalyticsWorld } from "../worlds/org-model-analytics.ts";

const test = spec.world((seed) => orgModelAnalyticsWorld(seed, { teammate: true }), { timeout: 900_000, needs: {}, resources: { surfaces: ["web"], services: ["den"] } });

const WORKSPACE_ORIGIN = "https://workspace.example.test:8787";
const LOOKALIKE_ORIGINS = ["https://workspace.example.test.evil.test", "https://workspace.example.test:8788"];

async function readAnalytics(session: DenSession, orgId: string): Promise<Record<string, unknown>> {
  const result = await readOrganizationModelAnalytics(session, orgId);
  // 402 means plan gating is on; this journey needs the local default DEN_PLAN_GATING_ENABLED=false.
  expect(result.status).toBe(200);
  if (!result.models) throw new Error("Model analytics returned no models section");
  return result.models;
}

test("an organization's analytics, keys and sign-in origins never reach or serve another organization", { timeout: 600_000 }, async ({ world, user, probe, step }) => {
  const { den } = world;
  const primaryOrgId = await findMyOrganizationId(den.admin, "Analytics team");
  const otherOrg = await provisionOrg(den.ref, {});

  const events = [
    modelTelemetryEvent("model-analytics-session-a", "session.active", "prov/model-a", "default"),
    modelTelemetryEvent("model-analytics-session-a", "task.started", "prov/model-a", "default"),
    modelTelemetryEvent("model-analytics-session-b", "session.active", "prov/model-b", "manual"),
    modelTelemetryEvent("model-analytics-session-b", "task.started", "prov/model-b", "manual"),
  ];
  expect(await sendAppTelemetry(den.admin, primaryOrgId, events)).toBe(204);

  const primaryModels = await readAnalytics(den.admin, primaryOrgId);
  const usage30d = Array.isArray(primaryModels.usage30d) ? primaryModels.usage30d : [];
  expect(usage30d).toHaveLength(2);
  expect(usage30d).toEqual(expect.arrayContaining([
    { id: "prov/model-a", label: "prov/model-a", sessions: 1 },
    { id: "prov/model-b", label: "prov/model-b", sessions: 1 },
  ]));
  expect(primaryModels.selection30d).toEqual({ default: 1, manual: 1 });

  const otherModels = await readAnalytics(otherOrg.admin, otherOrg.orgId);
  expect(otherModels.usage30d).toEqual([]);
  expect(otherModels.selection30d).toEqual({ default: 0, manual: 0 });
  await user.see({ role: "heading", label: "Usage & adoption" }, { timeoutMs: 60_000 });
  await user.click({ role: "button", label: "Refresh analytics" });
  await user.see({ text: /^prov\/model-a\s+1$/ }, { timeoutMs: 30_000 });
  await user.see({ text: /^prov\/model-b\s+1$/ });
  await user.notSee({ text: "No model usage yet" });

  await step("adoption uses neutral statistics for the same model sessions", async () => {
    const stats = (await probe.dom('[data-analytics-stat]')).elements;
    expect(stats.length).toBeGreaterThan(0);
    expect((await probe.dom('[data-analytics-stat] svg')).elements).toHaveLength(0);
    expect(await readAnalytics(den.admin, primaryOrgId)).toEqual(primaryModels);
    await user.screenshot();
    await user.click({ role: "link", label: "Models & usage" });
    await user.see({ role: "heading", label: "Models & usage" });
    await user.screenshot();
    await user.click({ role: "link", label: /^Usage & adoption$/ });
    await user.see({ text: "prov/model-b" });
  });

  await step("an outage keeps the error distinct from empty usage and a retry restores counts", async () => {
    await world.analyticsStoreUnavailable(true);
    expect((await readOrganizationModelAnalytics(den.admin, primaryOrgId)).status).toBe(500);
    await user.reload();
    await user.see({ text: "Couldn't load analytics" }, { timeoutMs: 60_000 });
    await user.notSee({ text: "No model usage yet" });
    await user.notSee({ text: "No usage events yet" });
    await user.notSee({ role: "button", label: "Refresh analytics" });
    await user.see({ role: "button", label: "Try again" });
    await user.notSee({ text: "Your data is safe. This is usually a short connection problem." });
    await user.screenshot();
    await world.analyticsStoreUnavailable(false);
    await user.click({ role: "button", label: "Try again" });
    await user.see({ text: "prov/model-a" }, { timeoutMs: 30_000 });
    await user.notSee({ text: "Couldn't load analytics" });
    await user.screenshot();
  });
  await user.click({ role: "link", label: "Models & usage" });
  await user.see({ role: "heading", label: "Models & usage" });
  await user.notSee({ role: "button", label: "Subscribe" });
  await user.click({ role: "link", label: /^Usage & adoption$/ });
  await user.see({ role: "heading", label: "Usage & adoption" });
  await user.see({ text: "prov/model-b" });

  await step("a web origin the owner approves serves only their organization's members, exactly, until removed", async () => {
    const teammate = den.members.teammate;
    if (!teammate) throw new Error("The analytics organization has no teammate");
    const refused = { status: 400, returnUrl: null, error: "invalid_return_url" };
    expect(await requestSignInHandoff(teammate, `${WORKSPACE_ORIGIN}/`)).toEqual(refused);
    const owner = await freshSession(den.admin);
    expect(await setApprovedWebOrigin(owner, primaryOrgId, WORKSPACE_ORIGIN, true)).toBe(201);
    await user.navigate(`${den.ref.webUrl}/dashboard/org-settings`);
    await user.see({ text: "Approved web origins" }, { timeoutMs: 60_000 });
    await user.click({ text: "Approved web origins" });
    await user.see({ text: WORKSPACE_ORIGIN });
    await user.screenshot();
    expect(await requestSignInHandoff(teammate, `${WORKSPACE_ORIGIN}/`)).toMatchObject({ status: 200, returnUrl: `${WORKSPACE_ORIGIN}/signin` });
    expect(await requestSignInHandoff(otherOrg.admin, `${WORKSPACE_ORIGIN}/`)).toEqual(refused);
    for (const origin of LOOKALIKE_ORIGINS) expect(await requestSignInHandoff(teammate, `${origin}/`)).toEqual(refused);
    expect(await setApprovedWebOrigin(owner, primaryOrgId, WORKSPACE_ORIGIN, false)).toBe(204);
    expect(await requestSignInHandoff(teammate, `${WORKSPACE_ORIGIN}/`)).toEqual(refused);
  });
});
