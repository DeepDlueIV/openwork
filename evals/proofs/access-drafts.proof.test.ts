import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { accessDrafts } from "../worlds/access-drafts.ts";
import { record, rows } from "../worlds/org-invite.ts";

const test = spec.world(accessDrafts, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner keeps a team's unsaved draft across tabs, reviews newer saved settings and retries a failed save", async ({ world, user, probe, step, evidence }) => {
  let keyboardWorked = false;
  let panelLabelled = false;
  let tabStops = 0;
  await step("the owner edits commands and opens Browser without saving the command draft", async () => {
    await user.see({ role: "button", label: "Run commands" }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Run commands" });
    await user.click({ role: "option", label: "Block" });
    await user.see({ testId: "agent-permissions-save-bar" });
    await user.click({ role: "tab", label: "Agents" });
    await user.press("ArrowRight");
    const focused = await probe.dom('[role="tab"][aria-selected="true"]');
    keyboardWorked = focused.elements[0]?.text === "Browser" && focused.elements[0]?.focused === true;
    // Keep driving the old click path on dev so its failure witnesses the lost
    // draft too, rather than stopping solely on the missing arrow-key behavior.
    if (!keyboardWorked) await user.click({ role: "tab", label: "Browser" });
    await user.see({ role: "button", label: "Open websites" });
    const stops = await probe.dom('[role="tab"][tabindex="0"]');
    tabStops = stops.elements.length;
    const controls = await probe.dom('[role="tab"][aria-selected="true"][aria-controls]:not([aria-controls=""])');
    const labelledPanels = await probe.dom('[role="tabpanel"]:not([hidden])[aria-labelledby]:not([aria-labelledby=""])');
    panelLabelled = controls.elements.length === 1 && controls.elements[0]?.text === "Browser" && labelledPanels.elements.length === 1 && labelledPanels.elements.some((panel) => panel.text.includes("Open websites"));
    const selected = await probe.dom('[role="tab"][aria-selected="true"]');
    evidence.recordAssertionEvidence("Browser opens without saving the command draft", `selected=${selected.elements.map((entry) => entry.text).join()}; arrow navigation worked=${keyboardWorked}; tab stops=${tabStops}; selected panel labelled=${panelLabelled}`, selected.elements[0]?.text === "Browser");
    expect(selected.elements[0]?.text).toBe("Browser");
    await user.screenshot();
  });
  await step("saving Browser keeps the unsaved command change and asks the owner to review newer saved settings", async () => {
    await user.click({ role: "button", label: "Open websites" });
    await user.click({ role: "option", label: "Block" });
    await user.click({ role: "button", label: "Save changes" });
    await user.notSee({ testId: "agent-permissions-save-bar" });
    await user.click({ role: "tab", label: "Agents" });
    await user.see({ role: "button", label: "Run commands" }, { text: "Block" });
    await user.see({ text: "Saved settings changed while you were editing. Your draft is kept." });
    const disabled = await probe.dom('[data-testid="agent-permissions-save-bar"] button:disabled');
    evidence.recordAssertionEvidence("a refreshed policy cannot erase or silently overwrite the draft", `blocked save controls=${disabled.elements.length}; command draft remains Block`, disabled.elements.some((entry) => entry.text.includes("Save changes")));
    expect(disabled.elements.some((entry) => entry.text.includes("Save changes"))).toBe(true);
    await user.screenshot();
  });
  await step("after: the reviewed command draft saves without overwriting Browser", async () => {
    await user.click({ role: "button", label: "Keep my edits on latest settings" });
    await user.click({ role: "button", label: "Save changes" });
    await user.notSee({ testId: "agent-permissions-save-bar" });
    const policies = record((await probe.api(world.den.admin, "/v1/agent-permissions")).body);
    const settings = record(rows(policies.teams).find((entry) => entry.teamId === world.team)?.settings);
    const commands = record(settings.commands).decision;
    const websites = record(settings.websites).decision;
    evidence.recordAssertionEvidence("both independently edited areas are saved", `commands=${String(commands)}; websites=${String(websites)}`, commands === "deny" && websites === "deny");
    expect(commands).toBe("deny");
    expect(websites).toBe("deny");
    await user.screenshot();
  });
  await step("a failed save keeps the edited value and its retry in the same panel", async () => {
    await user.click({ role: "button", label: "Edit files" });
    await user.click({ role: "option", label: "Ask first" });
    await world.traffic.faults.status(world.faultPath(`/v1/agent-permissions/teams/${world.team}`), 503, { method: "PUT", body: { error: "unavailable", message: "Permission save unavailable" } });
    await user.click({ role: "button", label: "Save changes" });
    await user.see({ text: "Permission save unavailable" });
    await user.see({ role: "button", label: "Edit files" }, { text: "Ask first" });
    const rows = await probe.dom('[data-testid="agent-permissions-save-bar"]');
    evidence.recordAssertionEvidence("failed permission saves retain the draft", rows.elements.map((entry) => entry.text).join(), rows.elements.length === 1);
    expect(rows.elements).toHaveLength(1);
    await user.screenshot();
    await user.click({ role: "button", label: "Save changes" });
    await user.notSee({ testId: "agent-permissions-save-bar" });
  });
  await step("role permission edits survive History and return through correctly associated panels", async () => {
    await user.navigate(world.url(`/dashboard/permissions/${world.role}`));
    await user.see({ role: "tab", label: "Permissions" });
    await user.click({ role: "tab", label: "Permissions" });
    await user.type({ testId: "role-name" }, "Edited role draft", { replace: true });
    await user.click({ role: "switch", label: "View any team" });
    await user.see({ testId: "permission-set-save-bar" });
    await user.click({ role: "tab", label: "History" });
    await user.click({ role: "tab", label: "Permissions" });
    await user.see({ testId: "permission-set-save-bar" });
    await user.see({ testId: "role-name" }, { value: "Edited role draft" });
    const edited = await probe.dom('[data-permission-key="teams.view"][data-status="allow"]');
    const panels = await probe.dom('[role="tabpanel"]:not([hidden])');
    evidence.recordAssertionEvidence("the role draft remains in its only visible panel", `retained changed rows=${edited.elements.length}; visible panels=${panels.elements.length}`, edited.elements.length === 1 && panels.elements.length === 1);
    expect(edited.elements).toHaveLength(1);
    expect(panels.elements).toHaveLength(1);
    await user.screenshot();
  });
  await step("another team's settings and an ordinary member's access remain unchanged", async () => {
    await user.navigate(world.url(`/dashboard/members/teams/${world.other}?tab=agents`));
    await user.see({ role: "button", label: "Run commands" }, { text: "Allow" });
    await user.notSee({ testId: "agent-permissions-save-bar" });
    const refused = await probe.api(world.den.members.plain, "/v1/agent-permissions");
    evidence.recordAssertionEvidence("drafts and permissions stay scoped", `other team has no draft; member read HTTP ${refused.response.status}`, refused.response.status === 403);
    expect(refused.response.status).toBe(403);
    expect(keyboardWorked).toBe(true);
    expect(panelLabelled).toBe(true);
    expect(tabStops).toBe(1);
    await user.screenshot();
  });
});
