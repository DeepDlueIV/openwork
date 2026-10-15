import type { Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { readDefaultDesktopPolicy } from "./desktop-policies.ts";

/** Synthetic, isolated policies: defaults, dedicated team, member and shared multi-team/role scopes. */
export async function desktopSuggestions(seed: Seed) {
  const den = await seed.den({ web: true, org: {
    name: `Desktop Suggestions ${Date.now()}`, admin: { name: "Avery Owner" },
    members: { riley: { name: "Riley Writer" }, morgan: { name: "Morgan Reviewer" }, casey: { name: "Casey Shared" } },
  } });
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, { teamPageTabs: true, teamRoles: true, agentPermissions: true, orgDefaultModel: true });
  const setFlags = async (removal: boolean, tabs = true) => {
    const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { desktopPolicyScreenRemoval: removal, teamPageTabs: tabs } }) });
    if (!result.response.ok) throw new Error(`Setting rollout failed: ${result.text}`);
  };
  await setFlags(false);
  const context = await seed.api(den.admin, "/v1/org");
  const members = isRecord(context.body) ? records(context.body.members) : [];
  const memberId = (name: string) => {
    const id = members.find((member) => isRecord(member.user) && member.user.name === name)?.id;
    if (typeof id !== "string") throw new Error(`Missing seeded member ${name}`);
    return id;
  };
  const team = async (name: string, person: string) => {
    const result = await seed.api(den.admin, "/v1/teams", { method: "POST", body: JSON.stringify({ name, memberIds: [memberId(person)] }) });
    const item = isRecord(result.body) && isRecord(result.body.team) ? result.body.team : null;
    if (!result.response.ok || typeof item?.id !== "string") throw new Error(`Creating ${name}: ${result.text}`);
    return item.id;
  };
  const writers = await team("Writers", "Riley Writer");
  const reviewers = await team("Reviewers", "Morgan Reviewer");
  const sharedA = await team("Shared North", "Casey Shared");
  const sharedB = await team("Shared South", "Casey Shared");
  const defaults = await readDefaultDesktopPolicy(seed, den.admin);
  const everyonePrompts = ["Summarize my notes", "Plan my week"];
  const everyoneDescriptions = ["Find decisions and next steps", "Make time for focused work"];
  const updated = await seed.api(den.admin, `/v1/desktop-policies/${String(defaults.id)}`, { method: "PATCH", body: JSON.stringify({ policyName: defaults.policyName, policy: { ...(isRecord(defaults.policy) ? defaults.policy : {}), allowCustomProviders: false, allowZenModel: true, onboardingPrompts: everyonePrompts, onboardingPromptDescriptions: everyoneDescriptions } }) });
  if (!updated.response.ok) throw new Error(`Setting defaults: ${updated.text}`);
  const createPolicy = async (body: Record<string, unknown>) => {
    const result = await seed.api(den.admin, "/v1/desktop-policies", { method: "POST", body: JSON.stringify(body) });
    if (!result.response.ok) throw new Error(`Seeding policy: ${result.text}`);
    return result.body;
  };
  await createPolicy({ policyName: "Writer desktop settings", teamIds: [writers], policy: { allowAlphaUpdates: false, allowMultipleWorkspaces: false } });
  const teamPrompts = ["Review a draft", "Check my references"];
  const teamDescriptions = ["Give constructive feedback", "Find missing sources"];
  await createPolicy({ policyName: "Reviewer suggestions", teamIds: [reviewers], priority: 10, policy: { allowAlphaUpdates: false, onboardingPrompts: teamPrompts, onboardingPromptDescriptions: teamDescriptions } });
  const memberPrompts = ["Prepare my private checklist", "Review my own notes"];
  const memberDescriptions = ["Personal preparation", "Personal follow-up"];
  await createPolicy({ policyName: "Member suggestions", memberIds: [memberId("Morgan Reviewer")], priority: 50, policy: { onboardingPrompts: memberPrompts, onboardingPromptDescriptions: memberDescriptions } });
  await createPolicy({ policyName: "Shared suggestions", teamIds: [sharedA, sharedB], roles: ["owner"], priority: 20, policy: { onboardingPrompts: ["Prepare a shared briefing", "Review shared actions"], onboardingPromptDescriptions: ["Shared briefing", "Shared next steps"], allowAlphaUpdates: false } });
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/desktop-policies", headless: true, viewport: { width: 1440, height: 1100 } });
  const memberWeb = await seed.web({ den, signedInAs: den.members.riley, startPath: `/dashboard/members/teams/${writers}?tab=desktop`, headless: true, viewport: { width: 1440, height: 1100 } });
  return {
    den, web, memberWeb, setFlags, writers, reviewers, sharedA, sharedB,
    everyonePrompts, everyoneDescriptions, teamPrompts, teamDescriptions, memberPrompts, memberDescriptions,
    defaultId: String(defaults.id),
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
  };
}
