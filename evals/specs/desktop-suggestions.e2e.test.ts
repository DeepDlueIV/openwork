import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { desktopSuggestions } from "../worlds/desktop-suggestions.ts";
import { isRecord, records } from "../worlds/library.ts";

const test = spec.world(desktopSuggestions, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner manages desktop suggestions in Everyone and teams without losing member or shared policies", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const policies = async () => {
    const result = await probe.api(world.den.admin, "/v1/desktop-policies");
    expect(result.response.status).toBe(200);
    return isRecord(result.body) ? records(result.body.desktopPolicies) : [];
  };
  const config = async (person: "riley" | "morgan" | "casey" | "admin") => {
    const result = await probe.api(person === "admin" ? world.den.admin : world.den.members[person], "/v1/me/desktop-config");
    expect(result.response.status).toBe(200);
    if (!isRecord(result.body)) throw new Error("Missing desktop config");
    return result.body;
  };
  const promptConfig = (value: Record<string, unknown>) => ({ onboardingPrompts: value.onboardingPrompts, onboardingPromptDescriptions: value.onboardingPromptDescriptions });
  let beforePolicies: Record<string, unknown>[] = [];
  let beforeRiley: Record<string, unknown> = {};
  let beforeMorgan: Record<string, unknown> = {};
  let beforeShared: Record<string, unknown> = {};
  let beforeOwner: Record<string, unknown> = {};

  await step("before: prompt suggestions live in Desktop policies alongside Everyone, team, member and shared assignments", async () => {
    await owner.see({ role: "tab", label: "Desktop policies" }, { timeoutMs: 90_000 });
    await owner.see({ text: "Reviewer suggestions" });
    await owner.see({ text: "Member suggestions" });
    await owner.see({ text: "Shared suggestions" });
    beforePolicies = await policies();
    const memberScoped = beforePolicies.filter((policy) => records(policy.assignments).some((assignment) => typeof assignment.orgMemberId === "string"));
    expect(memberScoped).toHaveLength(1);
    evidence.recordAssertionEvidence("Member-scoped policies in this isolated seeded organization only", `${memberScoped.length} member-scoped policy among ${beforePolicies.length} policies; not a production count`, memberScoped.length === 1);
    beforeRiley = await config("riley");
    beforeMorgan = await config("morgan");
    beforeShared = await config("casey");
    beforeOwner = await config("admin");
    const sharedConfig = { onboardingPrompts: ["Prepare a shared briefing", "Review shared actions"], onboardingPromptDescriptions: ["Shared briefing", "Shared next steps"] };
    expect(promptConfig(beforeShared)).toEqual(sharedConfig);
    expect(promptConfig(beforeOwner)).toEqual(sharedConfig);
    expect(promptConfig(beforeRiley)).toEqual({ onboardingPrompts: world.everyonePrompts, onboardingPromptDescriptions: world.everyoneDescriptions });
    expect(promptConfig(beforeMorgan)).toEqual({ onboardingPrompts: world.memberPrompts, onboardingPromptDescriptions: world.memberDescriptions });
    await owner.screenshot();
    await owner.navigate(world.url(`/dashboard/desktop-policies/${world.defaultId}`));
    await owner.see({ text: "Edit desktop policy" }, { timeoutMs: 30_000 });
    await owner.click({ placeholder: "Enter a suggested prompt", nth: 0 });
    await owner.screenshot();
  });

  await step("after: Desktop tabs replace the screen without changing desktop responses or stored policies", async () => {
    await world.setFlags(true);
    await owner.navigate(world.url("/dashboard/members/teams/everyone?tab=desktop"));
    await owner.see({ testId: "desktop-suggestions" }, { timeoutMs: 60_000 });
    await owner.see({ text: world.everyonePrompts[0] });
    expect(promptConfig(await config("riley"))).toEqual(promptConfig(beforeRiley));
    expect(promptConfig(await config("morgan"))).toEqual(promptConfig(beforeMorgan));
    expect(promptConfig(await config("casey"))).toEqual(promptConfig(beforeShared));
    expect(promptConfig(await config("admin"))).toEqual(promptConfig(beforeOwner));
    expect(await policies()).toEqual(beforePolicies);
    const tabs = (await page.dom('[role="tab"]')).elements.map((element) => element.text.trim());
    expect(tabs).toContain("Desktop");
    evidence.recordAssertionEvidence("Feature-on parity before any edits", "Exact prompts, descriptions and all stored policies match feature-off; Desktop tab visible", true);
    await owner.screenshot();
  });

  await step("existing member, team and shared suggestion lists remain readable under Everyone", async () => {
    await owner.click({ text: "Other scoped suggestions (3)" });
    await owner.see({ text: "Member suggestions" });
    await owner.see({ text: "Reviewer suggestions" });
    await owner.see({ text: "Shared suggestions" });
    evidence.recordAssertionEvidence("Existing scoped suggestion lists remain visible", "Member, team and shared policy lists are retained read-only below Everyone's defaults", true);
    await owner.screenshot();
    await owner.click({ text: "Other scoped suggestions (3)" });
  });

  await step("Everyone can add a third suggestion while AI Gateway's model access fields stay unchanged", async () => {
    await owner.click({ role: "button", label: "Add suggestion" });
    await owner.type({ label: "Prompt 3" }, "Prepare a daily briefing");
    await owner.type({ label: "Description 3" }, "Start with the important decisions");
    await owner.screenshot();
    await owner.click({ role: "button", label: "Save suggestions" });
    await owner.see({ testId: "desktop-suggestion-2" }, { timeoutMs: 30_000 });
    const after = await config("riley");
    expect(after.onboardingPrompts).toEqual([...world.everyonePrompts, "Prepare a daily briefing"]);
    expect(after.onboardingPromptDescriptions).toEqual([...world.everyoneDescriptions, "Start with the important decisions"]);
    const defaults = (await policies()).find((policy) => policy.isDefault);
    expect(defaults?.policy).toMatchObject({ allowCustomProviders: false, allowZenModel: true });
    const original = beforePolicies.find((policy) => policy.isDefault);
    const withoutPrompts = (policy: unknown) => {
      if (!isRecord(policy)) return {};
      const { onboardingPrompts: _prompts, onboardingPromptDescriptions: _descriptions, ...other } = policy;
      return other;
    };
    expect(withoutPrompts(defaults?.policy)).toEqual(withoutPrompts(original?.policy));
    evidence.recordAssertionEvidence("Everyone's desktop suggestions and AI Gateway access", "Three exact prompt/description pairs delivered; every other default-policy field unchanged", true);
    await owner.screenshot();
  });

  await step("removing a suggestion asks first, Cancel keeps it, and Remove keeps the remaining two", async () => {
    await owner.click({ role: "button", label: "Actions for suggestion 3" });
    await owner.click({ role: "menuitem", label: "Remove" });
    await owner.see({ testId: "confirm-dialog" });
    await owner.screenshot();
    await owner.click({ testId: "confirm-dialog-cancel" });
    expect((await config("riley")).onboardingPrompts).toHaveLength(3);
    await owner.click({ role: "button", label: "Actions for suggestion 3" });
    await owner.click({ role: "menuitem", label: "Remove" });
    await owner.click({ role: "button", label: /^Remove$/ });
    await page.eventually(() => page.dom('[data-testid="desktop-suggestion-2"]'), { within: 30_000, label: "third suggestion removed", until: (value) => value.elements.length === 0 });
    await owner.notSee({ testId: "desktop-suggestion-2" });
    expect(promptConfig(await config("riley"))).toEqual(promptConfig(beforeRiley));
    evidence.recordAssertionEvidence("Confirmed removal", "Cancel retains three; Remove restores the exact original two prompts and descriptions", true);
    await owner.screenshot();
  });

  await step("Writers inherits Everyone until its owner saves a replacement list", async () => {
    await owner.navigate(world.url(`/dashboard/members/teams/${world.writers}?tab=desktop`));
    await owner.see({ text: "Inherit from Everyone" }, { timeoutMs: 30_000 });
    await owner.screenshot();
    await owner.click({ role: "button", label: "Change for team" });
    await owner.type({ label: "Prompt 1" }, "Draft a writing outline", { replace: true });
    await owner.type({ label: "Description 1" }, "Structure the first draft", { replace: true });
    await owner.click({ role: "button", label: "Save suggestions" });
    await owner.see({ text: "Changed for team" }, { timeoutMs: 30_000 });
    expect(promptConfig(await config("riley"))).toEqual({ onboardingPrompts: ["Draft a writing outline", world.everyonePrompts[1]], onboardingPromptDescriptions: ["Structure the first draft", world.everyoneDescriptions[1]] });
    expect(promptConfig(await config("morgan"))).toEqual(promptConfig(beforeMorgan));
    evidence.recordAssertionEvidence("A team replacement is not appended to Everyone", "Riley receives exactly the two Writer prompts; Morgan's member policy is unchanged", true);
    await owner.screenshot();
  });

  await step("Use Everyone's removes only the team's suggestion override and restores inheritance", async () => {
    await owner.click({ role: "button", label: "Use Everyone's" });
    await owner.see({ text: "Inherit from Everyone" }, { timeoutMs: 30_000 });
    expect(promptConfig(await config("riley"))).toEqual(promptConfig(beforeRiley));
    const after = await policies();
    for (const original of beforePolicies.filter((policy) => !policy.isDefault)) expect(after.find((policy) => policy.id === original.id)).toEqual(original);
    evidence.recordAssertionEvidence("Inheritance restored without deleting policies", "Riley gets Everyone's exact prompts/descriptions; original member, team and shared policies are byte-for-byte unchanged", true);
    await owner.screenshot();
  });

  await step("Everyone can return to built-in desktop suggestions without changing member overrides", async () => {
    await owner.navigate(world.url("/dashboard/members/teams/everyone?tab=desktop"));
    await owner.see({ role: "button", label: "Use built-in suggestions" }, { timeoutMs: 30_000 });
    await owner.click({ role: "button", label: "Use built-in suggestions" });
    await owner.see({ text: "Built-in desktop suggestions" }, { timeoutMs: 30_000 });
    expect((await config("riley")).onboardingPrompts).toBeUndefined();
    expect(promptConfig(await config("morgan"))).toEqual(promptConfig(beforeMorgan));
    evidence.recordAssertionEvidence("Built-in suggestions restored", "Riley has no organization prompt override; Morgan retains the member-specific prompts", true);
    await owner.screenshot();
  });

  await step("Set suggestions restores Everyone's two prompt and description pairs", async () => {
    await owner.click({ role: "button", label: "Set suggestions" });
    for (let index = 0; index < 2; index++) {
      await owner.type({ label: `Prompt ${index + 1}` }, world.everyonePrompts[index]!);
      await owner.type({ label: `Description ${index + 1}` }, world.everyoneDescriptions[index]!);
    }
    await owner.click({ role: "button", label: "Save suggestions" });
    await owner.see({ text: world.everyonePrompts[0] }, { timeoutMs: 30_000 });
    expect(promptConfig(await config("riley"))).toEqual(promptConfig(beforeRiley));
    evidence.recordAssertionEvidence("Everyone's custom suggestions restored", "The exact original prompts and descriptions are delivered again", true);
    await owner.screenshot();
  });

  await step("shared team, role and overlapping member assignments stay visible but cannot be rewritten by a team editor", async () => {
    for (const teamId of [world.sharedA, world.reviewers]) {
      await owner.navigate(world.url(`/dashboard/members/teams/${teamId}?tab=desktop`));
      await owner.see({ text: /Suggestions have shared or overlapping policy assignments/ }, { timeoutMs: 30_000 });
      await owner.notSee({ role: "button", label: "Edit suggestions" });
      await owner.notSee({ role: "button", label: "Use Everyone's" });
      await owner.screenshot();
    }
    expect(promptConfig(await config("morgan"))).toEqual(promptConfig(beforeMorgan));
    expect(promptConfig(await config("casey"))).toEqual(promptConfig(beforeShared));
    expect(promptConfig(await config("admin"))).toEqual(promptConfig(beforeOwner));
    evidence.recordAssertionEvidence("Overlapping policies are preserved", "Shared North's multi-team/owner policy and Reviewers' member override lock editing; Morgan still receives the higher-priority member prompts", true);
  });

  await step("a member without management permissions cannot open the suggestion editor", async () => {
    const member = user.on(world.memberWeb);
    await member.reload();
    await member.notSee({ testId: "desktop-suggestions" }, { timeoutMs: 10_000 });
    await member.notSee({ role: "button", label: "Save suggestions" });
    const denied = await probe.api(world.den.members.riley, "/v1/desktop-policies");
    expect(denied.response.status).toBe(403);
    evidence.recordAssertionEvidence("Member permission boundary", `GET /v1/desktop-policies → ${denied.response.status}; editor and Save absent`, denied.response.status === 403);
    await member.screenshot();
  });

  await step("turning Team page tabs off restores the old policy screen even while removal is on", async () => {
    await world.setFlags(true, false);
    await owner.navigate(world.url("/dashboard/desktop-policies"));
    await owner.see({ role: "tab", label: "Desktop policies" }, { timeoutMs: 60_000 });
    expect(promptConfig(await config("riley"))).toEqual(promptConfig(beforeRiley));
    expect(promptConfig(await config("morgan"))).toEqual(promptConfig(beforeMorgan));
    evidence.recordAssertionEvidence("Conjunction rollback", "teamPageTabs off restores Desktop policies; member desktop responses still match the original", true);
    await owner.screenshot();
  });
});
