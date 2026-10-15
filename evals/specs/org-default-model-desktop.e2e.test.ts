import { expect } from "vitest";
import { spec, type Agent, type Probe, type User } from "@openwork/testkit";
import { orgDefaultModelDesktop, orgDefaultModelDesktopOff } from "../worlds/org-default-model-desktop.ts";

const on = spec.world(orgDefaultModelDesktop, { timeout: 900_000,
  resources: { surfaces: ["desktop"], services: ["den"], nativeReason: "Verify the real signed-in Electron desktop and its local v2 engine receiving Den defaults." },
  needs: { placement: "local" } });
const off = spec.world(orgDefaultModelDesktopOff, { timeout: 900_000,
  resources: { surfaces: ["desktop"], services: ["den"], nativeReason: "Verify the off flag on the real signed-in Electron desktop, preserving the previous preference." },
  needs: { placement: "local" } });
const picker = '[data-testid="composer-model-picker"]';
const changeModel = { role: "button", label: "Change model" } as const;

async function newSession(user: User, probe: Probe, agent: Agent) {
  await user.see("composer", { editable: true, timeoutMs: 120_000 });
  const prior = await probe.hash();
  await user.press("Escape");
  await user.click({ role: "button", label: "New session" });
  // Materialize the empty draft through the same create-task action used by the app, without sending to an upstream.
  await agent.createSession();
  const route = await probe.eventually(() => probe.hash(), {
    within: 30_000, label: "a different new session opens",
    until: (value) => value !== prior && /\/session\/[^/]+$/.test(value),
  });
  const sessionId = route.split("/session/")[1];
  if (!sessionId) throw new Error(`New task did not create a session: ${route}`);
  await user.see("composer", { editable: true });
  return { route, sessionId };
}

async function selected(user: User, probe: Probe, sessionId: string, model: { providerID: string; modelID: string }, name: string) {
  await user.see(changeModel, { text: name, timeoutMs: 90_000 });
  await probe.eventually(() => probe.storage("openwork.sessionModels.v1"), {
    within: 30_000, label: "the session remembers its model",
    until: (value) => typeof value === "object" && value !== null && JSON.stringify(Reflect.get(value, sessionId)?.model) === JSON.stringify(model),
  });
  expect(await probe.storage("openwork.sessionModels.v1")).toMatchObject({ [sessionId]: { model } });
  await user.click(changeModel);
  await user.see({ testId: `model-option-${model.providerID}-${model.modelID}` });
  const checked = await probe.dom(`${picker} [data-model-key="${model.providerID}:${model.modelID}"][data-checked="true"]`);
  expect(checked.elements).toHaveLength(1);
}

on("a signed-in desktop member starts new v2 chats on their team's model while a member without an override gets the organization default", async ({ world, user, probe, agent, step, evidence }) => {
  const member = user.on(world.app);
  const observed = probe.on(world.app);
  const team = { providerID: world.team.providerId, modelID: world.team.modelId };
  const organization = { providerID: world.organization.providerId, modelID: world.organization.modelId };
  let first = { route: "", sessionId: "" };

  await step("given Den assigns Model A to the organization and Model B to the member's team", async () => {
    await member.see("composer", { editable: true, timeoutMs: 120_000 });
    const config = await probe.api(world.maya, "/v1/me/desktop-config");
    expect(config.body).toMatchObject({ defaultModel: { ...team, source: "team", teamName: "Research" } });
    const status = await observed.desktopApi("/experimental/engine-v2-preview/status");
    expect(status.body).toMatchObject({ enabled: true, chatRouting: true });
    evidence.recordAssertionEvidence("Den's team default reaches a real v2 desktop", `Previous preference=${JSON.stringify(world.previous)}; Den default=${JSON.stringify(team)}; engine=${JSON.stringify(status.body)}`, true);
    await member.screenshot();
  });

  await step("after opening a new chat, the team member's model picker selects Model B", async () => {
    first = await newSession(member, observed, agent.on(world.app));
    await selected(member, observed, first.sessionId, team, "Model B");
    evidence.recordAssertionEvidence("A newly created team-member session uses the override", `New session=${first.sessionId}; selected=${JSON.stringify(team)}; previous desktop default=${JSON.stringify(world.previous)}`, true);
    await member.screenshot();
    await member.press("Escape");
  });

  await step("the member changes only this chat to Model A", async () => {
    await member.click(changeModel);
    await member.click({ testId: `model-option-${organization.providerID}-${organization.modelID}` });
    await selected(member, observed, first.sessionId, organization, "Model A");
    evidence.recordAssertionEvidence("The session's model remains editable", `${first.sessionId}: Model B → Model A; stored=${JSON.stringify(await observed.storage("openwork.sessionModels.v1"))}`, true);
    await member.screenshot();
    await member.press("Escape");
  });

  await step("reloading preserves Model A in this chat while another new chat starts on Model B", async () => {
    await member.reload();
    await selected(member, observed, first.sessionId, organization, "Model A");
    await member.press("Escape");
    const next = await newSession(member, observed, agent.on(world.app));
    await selected(member, observed, next.sessionId, team, "Model B");
    expect(await observed.storage("openwork.sessionModels.v1")).toMatchObject({ [first.sessionId]: { model: organization }, [next.sessionId]: { model: team } });
    evidence.recordAssertionEvidence("Changing one session does not change the organization default or another session", `Reloaded first=${first.sessionId}: Model A; second=${next.sessionId}: Model B; both session selections retained`, true);
    await member.screenshot();
    await member.press("Escape");
  });

  await step("a member with no team override opens a new chat on Model A", async () => {
    if (!world.noOverrideApp) throw new Error("The second member's desktop was not launched");
    const other = user.on(world.noOverrideApp);
    const otherProbe = probe.on(world.noOverrideApp);
    const session = await newSession(other, otherProbe, agent.on(world.noOverrideApp));
    await selected(other, otherProbe, session.sessionId, organization, "Model A");
    const config = await probe.api(world.nora, "/v1/me/desktop-config");
    expect(config.body).toMatchObject({ defaultModel: { ...organization, source: "organization" } });
    evidence.recordAssertionEvidence("A separate member profile inherits the organization default", `Member has no team; new session=${session.sessionId}; selected=${JSON.stringify(organization)}; team member's new session remains Model B`, true);
    await other.screenshot();
  });
});

off("a desktop member keeps their previous default in new v2 sessions when organization model defaults are off", async ({ world, user, probe, agent, step, evidence }) => {
  const member = user.on(world.app);
  const observed = probe.on(world.app);
  await step("given saved organization and team defaults exist but their feature is off", async () => {
    await member.see("composer", { editable: true, timeoutMs: 120_000 });
    const config = await probe.api(world.maya, "/v1/me/desktop-config");
    expect(config.body).not.toHaveProperty("defaultModel");
    const settings = await probe.api(world.owner, "/v1/org/default-model");
    expect(settings.response.status).toBe(404);
    evidence.recordAssertionEvidence("The off flag leaves saved model choices inert", `Saved org=Model A, team=Model B; GET settings=${settings.response.status}; desktop config has no defaultModel`, true);
    await member.screenshot();
  });
  await step("a new chat's picker selects the previous desktop default, not either managed model", async () => {
    const session = await newSession(member, observed, agent.on(world.app));
    await selected(member, observed, session.sessionId, world.previous, "Previous desktop default");
    evidence.recordAssertionEvidence("Feature off preserves the previous default", `New session=${session.sessionId}; selected=${JSON.stringify(world.previous)}; not org Model A or team Model B`, true);
    await member.screenshot();
    await member.press("Escape");
  });
  await step("another new chat also keeps the previous desktop default", async () => {
    const session = await newSession(member, observed, agent.on(world.app));
    await selected(member, observed, session.sessionId, world.previous, "Previous desktop default");
    evidence.recordAssertionEvidence("Feature off stays inert across session creation", `Second new session=${session.sessionId}; selected=${JSON.stringify(world.previous)}`, true);
    await member.screenshot();
  });
});
