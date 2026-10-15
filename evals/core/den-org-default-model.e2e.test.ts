import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denOrgDefaultModel } from "../worlds/den-org-default-model.ts";

// An owner chooses the model new desktop chats start with (feature
// orgDefaultModel) in Org settings, then overrides it for one team and sees
// the inherit state, the override state and the conflict rule on each team's
// Access tab. Den, its permissions and saves are real; only the provider's
// endpoint is a placeholder, because nothing here runs a model.
const test = spec.world(denOrgDefaultModel, {
  timeout: 900_000,
  resources: { surfaces: ["web"], services: ["den"] },
  needs: { placement: "local", commands: ["pnpm", "bun"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
});

const orgPicker = { role: "combobox", label: "Default model" } as const;
const teamPicker = { role: "combobox", label: "New desktop chats start on" } as const;

test("an owner sets the organization default model and overrides it per team in Den", { tags: ["user-flow"] }, async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);

  await step("with the feature off, Org settings has no default model section", async () => {
    await owner.see({ role: "heading", text: "Org settings" }, { timeoutMs: 120_000 });
    await owner.notSee({ testId: "org-default-model-section" });
    await owner.screenshot();
  });

  await step("turned on with no models yet, the section points the owner to set models up", async () => {
    await world.setFeature(true);
    await owner.reload();
    await owner.see({ testId: "default-model-empty" }, { timeoutMs: 60_000 });
    await owner.see({ text: "Set up models" });
    await owner.screenshot();
  });

  const providerId = await world.addProvider();

  await step("the owner picks the organization default from the organization's models", async () => {
    await owner.reload();
    await owner.see(orgPicker, { timeoutMs: 60_000 });
    await owner.click(orgPicker);
    await owner.see({ role: "option", label: /Claude Opus/ });
    await owner.screenshot();
    await owner.click({ role: "option", label: /Claude Opus/ });
    await owner.see({ text: /New desktop chats start on Claude Opus/ });
    const saved = await probe.api(world.den.admin, "/v1/org/default-model");
    expect(saved.body).toMatchObject({ everyone: { providerId, modelId: "claude-opus-example" } });
    await owner.screenshot();
  });

  await step("a member without Manage OpenWork Models cannot change the organization default", async () => {
    const member = world.den.members.maya;
    if (!member) throw new Error("The seeded member is missing");
    const denied = await probe.api(member, "/v1/org/default-model/everyone", {
      method: "PUT", headers: { "content-type": "application/json", "x-openwork-org-id": world.orgId }, body: JSON.stringify({ model: null }),
    });
    expect(denied.response.status).toBe(403);
    const saved = await probe.api(world.den.admin, "/v1/org/default-model");
    expect(saved.body).toMatchObject({ everyone: { providerId, modelId: "claude-opus-example" } });
    evidence.recordAssertionEvidence("A member cannot change the organization default", `PUT as a member returned ${denied.response.status}; the default is still Claude Opus`, denied.response.status === 403);
  });

  await step("a team uses the organization default until the owner overrides it", async () => {
    await owner.navigate(world.url(`/dashboard/members/teams/${encodeURIComponent(world.teams.research)}`));
    await owner.see({ testId: "team-default-model-section" }, { timeoutMs: 60_000 });
    await owner.see({ text: "From organization" });
    await owner.screenshot();
    await owner.click(teamPicker);
    await owner.click({ role: "option", label: /Claude Sonnet/ });
    await owner.see({ text: "Overridden" });
    await owner.see({ text: /New desktop chats start on Claude Sonnet/ });
    await owner.screenshot();
  });

  await step("a member on two teams with different models is shown starting on the organization default", async () => {
    await owner.navigate(world.url(`/dashboard/members/teams/${encodeURIComponent(world.teams.design)}`));
    await owner.see(teamPicker, { timeoutMs: 60_000 });
    await owner.click(teamPicker);
    await owner.click({ role: "option", label: /Claude Haiku/ });
    await owner.see({ text: /1 member is also on a team with a different model, so they start on the organization default/ });
    await owner.screenshot();
  });

  await step("the owner sends a team back to the organization default, which names its model", async () => {
    await owner.navigate(world.url(`/dashboard/members/teams/${encodeURIComponent(world.teams.research)}`));
    await owner.see(teamPicker, { timeoutMs: 60_000 });
    await owner.click(teamPicker);
    await owner.see({ role: "option", label: /Organization default, Anthropic/ });
    await owner.screenshot();
    await owner.click({ role: "option", label: /Organization default, Anthropic/ });
    await owner.see({ text: /This team uses the organization default/ });
    await owner.see({ text: "From organization" });
    await owner.screenshot();
    const saved = await probe.api(world.den.admin, "/v1/org/default-model");
    const teams = typeof saved.body === "object" && saved.body !== null && "teams" in saved.body && Array.isArray(saved.body.teams) ? saved.body.teams : [];
    const research = teams.find((team: unknown) => typeof team === "object" && team !== null && "teamId" in team && team.teamId === world.teams.research);
    expect(research).toMatchObject({ model: null });
  });

  await step("Org settings reports how many teams use their own model", async () => {
    await owner.navigate(world.url("/dashboard/org-settings"));
    await owner.see({ text: "1 team uses its own model." }, { timeoutMs: 60_000 });
    await owner.screenshot();
  });
});
