import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { accessInventory } from "../worlds/access-inventory.ts";

const test = spec.world(accessInventory, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner searches every loaded role while lists and pickers keep only one small page mounted", async ({ world, user, probe, step, evidence }) => {
  for (const count of [10_000, 20, 1, 0]) {
    await step(`after: ${count} loaded custom roles use at most 50 mounted rows and search finds the last role`, async () => {
      await world.inventory(count);
      await user.reload();
      if (count) await user.see({ text: "Role 00000" }, { timeoutMs: 90_000 });
      else await user.see({ text: "No custom roles yet." }, { timeoutMs: 90_000 });
      const page = await probe.dom('[data-testid="role-row-custom"]');
      evidence.recordAssertionEvidence(`${count} roles are rendered as a bounded page`, `loaded inventory=${count}; mounted rows=${page.elements.length}`, page.elements.length === Math.min(count, 50));
      expect(page.elements).toHaveLength(Math.min(count, 50));
      await user.see({ testId: "roles-completeness" });
      await user.screenshot();
      if (count > 50) {
        await user.click({ role: "button", label: "Next roles" });
        await user.see({ text: "Role 00050" });
        expect((await probe.dom('[data-testid="role-row-custom"]')).elements).toHaveLength(50);
      }
      const needle = count ? `Role ${String(count - 1).padStart(5, "0")}` : "No matching role";
      const start = Date.now();
      await user.type({ placeholder: "Filter roles" }, needle, { replace: true });
      if (count) await user.see({ text: needle });
      else await user.see({ text: "No custom roles match your filter." });
      const found = await probe.dom('[data-testid="role-row-custom"]');
      evidence.recordAssertionEvidence(`input searches the full ${count}-role inventory`, `last-role matches=${found.elements.length}; input-to-result=${Date.now() - start}ms`, found.elements.length === (count ? 1 : 0));
      expect(found.elements).toHaveLength(count ? 1 : 0);
      await user.screenshot();
    });
  }
  await step("the role picker pages the same ten thousand roles and searches beyond its first page", async () => {
    await world.inventory(10_000);
    await user.navigate(world.url("/dashboard/members"));
    await user.click({ role: "button", label: "Add member" });
    await user.click({ testId: "member-role-change" });
    const mounted = await probe.dom('[data-testid="member-role-choice"] [role="option"]');
    expect(mounted.elements.length).toBeLessThanOrEqual(50);
    await user.click({ role: "button", label: "Next roles" });
    await user.see({ role: "option", label: /Role 00048/ });
    const start = Date.now();
    await user.type({ placeholder: "Search roles" }, "Role 09999", { replace: true });
    await user.see({ role: "option", label: /Role 09999/ });
    const found = await probe.dom('[data-testid="member-role-choice"] [role="option"]');
    const detailReads = (await world.traffic.requestLog()).filter((entry) => entry.method === "GET" && /\/permissions\/sets\/[^/?]+$/.test(entry.path));
    evidence.recordAssertionEvidence("picker input is bounded without one permissions request per role", `mounted options=${mounted.elements.length}; last-role matches=${found.elements.length}; detail reads=${detailReads.length}; input-to-result=${Date.now() - start}ms`, mounted.elements.length === 50 && found.elements.length === 1 && detailReads.length < 10);
    expect(found.elements).toHaveLength(1);
    expect(detailReads.length).toBeLessThan(10);
    await user.screenshot();
  });
  await step("a failed inventory is never presented as an empty or complete role list and retries in place", async () => {
    await user.navigate(world.url("/dashboard/members?tab=roles"));
    await world.failInventory();
    await user.reload();
    await user.see({ text: "Couldn't verify the complete role list. Try again before choosing a role." });
    await user.notSee({ testId: "roles-custom-empty" });
    await user.notSee({ testId: "roles-completeness" });
    await user.screenshot();
    await world.restoreInventory();
    await user.click({ role: "button", label: "Try again" });
    await user.see({ text: "Role 00000" });
    const restored = await probe.dom('[data-testid="role-row-custom"]');
    evidence.recordAssertionEvidence("retry restores a complete bounded inventory", `mounted rows after retry=${restored.elements.length}`, restored.elements.length === 50);
    expect(restored.elements).toHaveLength(50);
    await user.screenshot();
  });
});

test("an owner reads elevated access and every source on a narrow screen, with an in-place retry and no wider member access", async ({ world, user, probe, step, evidence }) => {
  await step("a narrow role row exposes all team sources through a keyboard-accessible disclosure", async () => {
    await world.inventory(1);
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.reload();
    await user.see({ text: "Role 00000" }, { timeoutMs: 90_000 });
    await user.click({ label: "Teams with Role 00000: 3 sources" });
    await user.see({ text: "Operations and support team" });
    const view = await probe.dom('[data-testid="role-row-custom"]');
    evidence.recordAssertionEvidence("all role sources are readable without hover", `viewport=${view.viewportWidth}; document=${view.documentWidth}; disclosed rows=${view.elements.length}`, view.documentWidth <= view.viewportWidth && view.elements.length === 1);
    expect(view.documentWidth).toBeLessThanOrEqual(view.viewportWidth);
    await user.screenshot();
  });
  await step("a failed team-access read offers retry instead of asking the owner to reload", async () => {
    await world.accessFailure();
    await user.navigate(world.url(`/dashboard/members/teams/${world.teams[0].id}?tab=access`));
    await user.see({ text: "Couldn't verify team access. Try again or ask an organization admin to check your access." });
    await user.click({ role: "button", label: "Try again" });
    await user.see({ text: "Shared editing tools" });
    const access = await probe.dom('[data-testid="team-plugin-access-row"]');
    evidence.recordAssertionEvidence("retry restores named sources and elevated roles", access.elements.map((entry) => entry.text).join("; "), access.elements.length === 2 && access.elements.every((entry) => entry.text.includes("Can manage")) && access.elements.some((entry) => entry.text.includes("Shared with this team")) && access.elements.some((entry) => entry.text.includes("Editorial resources and shared operations marketplace")));
    expect(access.elements).toHaveLength(2);
    expect(access.elements.every((entry) => entry.text.includes("Can manage"))).toBe(true);
    expect(access.documentWidth).toBeLessThanOrEqual(access.viewportWidth);
    await user.screenshot();
  });
  await step("a plain member still cannot read access for a team they do not belong to", async () => {
    const result = await probe.api(world.den.members.plain, `/v1/teams/${world.teams[0].id}/plugin-access`);
    evidence.recordAssertionEvidence("readable summaries do not expand authorization", `member read HTTP ${result.response.status}; shared tool name leaked=${result.text.includes("Shared editing tools")}`, [403, 404].includes(result.response.status) && !result.text.includes("Shared editing tools"));
    expect([403, 404]).toContain(result.response.status);
  });
});
