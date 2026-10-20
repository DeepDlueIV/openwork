import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { deploymentServiceReadinessSchema } from "@openwork/types/den/service-readiness";
import { localSettingsServices, cloudSettingsServices } from "../worlds/den-settings-services.ts";

const local = spec.world(localSettingsServices, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });
const cloud = spec.world(cloudSettingsServices, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

local("a self-hosted operator with ordinary membership checks deployment services from normal Settings", async ({ world, user, probe, step, evidence }) => {
  const operator = user.on(world.operator), operatorProbe = probe.on(world.operator);
  await step("the local operator opens Services through normal Settings without organization admin privileges", async () => {
    await operator.see({ testId: "member-dashboard" }, { timeoutMs: 60_000 });
    await operator.click({ role: "link", label: "Settings" });
    await operator.click({ role: "link", label: "Services" });
    await operator.see({ testId: "service-check-now" }, { timeoutMs: 60_000 });
    await operator.click({ testId: "den-command-palette-trigger" });
    await operator.type({ testId: "den-command-palette-input" }, "Services");
    await operator.see({ text: "Settings › Services" });
    await operator.press("Escape");
    const rows = await operatorProbe.dom('[data-testid^="service-status-"]');
    expect(rows.elements).toHaveLength(7);
    const context = await operatorProbe.api(world.den.admin, "/v1/org");
    expect(context.body).toMatchObject({ canManageDeploymentServices: true, currentMember: { role: "member" } });
    evidence.recordAssertionEvidence("Local installation authority is independent of organization role", `role=member; server capability=true; inventory rows=${rows.elements.length}`, rows.elements.length === 7);
    await operator.screenshot();
  });
  await step("after: Check now verifies the configured runner without a model call or delivery", async () => {
    await operatorProbe.eventually(() => operatorProbe.dom('[data-testid="service-check-now"]:not(:disabled)'), { within: 60_000, until: (value) => value.elements.length === 1, label: "Check now is available" });
    await operator.click({ testId: "service-check-now" });
    await operator.see({ testId: "service-state-database" }, { text: "Ready", timeoutMs: 60_000 });
    await operator.see({ testId: "service-state-headlessRunner" }, { text: "Ready", timeoutMs: 60_000 });
    await operator.see({ testId: "service-state-workbot" }, { text: "Not set up" });
    const response = await operatorProbe.api(world.den.admin, "/v1/org/deployment-services");
    const snapshot = deploymentServiceReadinessSchema.parse(response.body);
    expect(snapshot.services.find((service) => service.id === "headlessRunner")?.reason).toBe("health_verified");
    expect(world.fixtureCalls()).toBeGreaterThan(0);
    expect(world.unexpectedFixtureCalls()).toBe(0);
    evidence.recordAssertionEvidence("Readiness comes from authenticated health, not configured values", `runner=health_verified; health calls=${world.fixtureCalls()}; non-health calls=${world.unexpectedFixtureCalls()}`, world.fixtureCalls() > 0 && world.unexpectedFixtureCalls() === 0);
    await operator.screenshot();
  });
  await step("setup details name missing fields without exposing endpoint or credential values", async () => {
    await operator.click({ testId: "service-details-toggle-workbot" });
    await operator.see({ testId: "service-details-workbot" }, { text: /DEN_WORKBOT_URL/ });
    const details = await operatorProbe.dom('[data-testid="service-details-workbot"][open]');
    expect(details.elements).toHaveLength(1);
    const response = await operatorProbe.api(world.den.admin, "/v1/org/deployment-services");
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("http://127.0.0.1");
    expect(serialized).not.toContain("readiness-fixture-service-token");
    evidence.recordAssertionEvidence("Setup details disclose field names only", "DEN_WORKBOT_URL is visible; configured URLs and bearer tokens are absent", details.elements.length === 1 && !serialized.includes("http://127.0.0.1"));
    await operator.screenshot();
  });
  await step("organization ownership does not expose installation diagnostics", async () => {
    const owner = user.on(world.owner), ownerProbe = probe.on(world.owner);
    await owner.see({ testId: "den-org-sidebar" }, { timeoutMs: 60_000 });
    await owner.click({ role: "link", label: "Settings" });
    await owner.notSee({ role: "link", label: "Services" });
    await owner.click({ testId: "den-command-palette-trigger" });
    await owner.type({ testId: "den-command-palette-input" }, "Services");
    await owner.notSee({ text: "Settings › Services" });
    await owner.screenshot();
    await owner.press("Escape");
    await owner.navigate(`${world.den.ref.webUrl}/dashboard/services`);
    await ownerProbe.eventually(() => ownerProbe.dom('[data-testid="admin-access-state"][data-access-state="locked"]'), { within: 60_000, until: (value) => value.elements.length === 1, label: "Direct Services route is denied after access resolves" });
    await owner.notSee({ testId: "service-check-now" });
    const denied = await ownerProbe.api(world.den.members.owner, "/v1/org/deployment-services");
    expect(denied.response.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain("missingSettings");
    evidence.recordAssertionEvidence("Transferred ownership is not installation authority", `owner diagnostics=${denied.response.status}; no Services link, search result or Check now`, denied.response.status === 403);
    await owner.screenshot();
  });
  await step("ordinary members cannot open Services or obtain operator setup details", async () => {
    const member = user.on(world.member), memberProbe = probe.on(world.member);
    await member.see({ testId: "member-dashboard" }, { timeoutMs: 60_000 });
    await member.notSee({ role: "link", label: "Services" });
    await member.navigate(`${world.den.ref.webUrl}/dashboard/services`);
    await memberProbe.eventually(() => memberProbe.dom('[data-testid="admin-access-state"][data-access-state="locked"], [data-testid="member-dashboard"]'), { within: 60_000, until: (value) => value.elements.length > 0, label: "Member Services route is denied after access resolves" });
    await member.notSee({ testId: "service-check-now" });
    const denied = await memberProbe.api(world.den.members.member, "/v1/org/deployment-services");
    const minimal = await memberProbe.api(world.den.members.member, "/v1/org/service-readiness");
    expect(denied.response.status).toBe(403);
    expect(JSON.stringify(minimal.body)).not.toMatch(/missingSettings|"required"|DEN_HEADLESS_RUNNER_TOKEN/);
    evidence.recordAssertionEvidence("Members retain only the minimal unavailable-feature projection", `diagnostics=${denied.response.status}; minimal projection=${minimal.response.status}; no setup fields`, denied.response.status === 403 && minimal.response.ok);
    await member.screenshot();
  });
  await step("the normal Settings inventory remains usable on a narrow screen", async () => {
    await operator.resizeViewport({ width: 320, height: 740, deviceScaleFactor: 1 });
    await operator.navigate(`${world.den.ref.webUrl}/dashboard/services`);
    await operator.see({ testId: "service-status-database" }, { timeoutMs: 60_000 });
    const layout = await operatorProbe.dom("body");
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    evidence.recordAssertionEvidence("Services fits without sideways scrolling", `document=${layout.documentWidth}px; viewport=${layout.viewportWidth}px`, layout.documentWidth <= layout.viewportWidth);
    await operator.screenshot();
  });
});

cloud("cloud owners, members and internal operators cannot acquire self-hosted Settings Services", async ({ world, user, probe, step, evidence }) => {
  for (const [name, surface, session] of [
    ["organization owner", world.owner, world.den.members.owner],
    ["ordinary member", world.member, world.den.members.member],
    ["internal operator", world.operator, world.den.admin],
  ] as const) {
    await step(`the cloud ${name} has no infrastructure Services navigation or direct access`, async () => {
      const person = user.on(surface), personProbe = probe.on(surface);
      await person.see({ testId: "den-org-sidebar" }, { timeoutMs: 60_000 });
      if (name === "organization owner") await person.click({ role: "link", label: "Settings" });
      await person.notSee({ role: "link", label: "Services" });
      await person.click({ testId: "den-command-palette-trigger" });
      await person.type({ testId: "den-command-palette-input" }, "Services");
      await person.notSee({ text: "Settings › Services" });
      await person.screenshot();
      await person.press("Escape");
      await person.navigate(`${world.den.ref.webUrl}/dashboard/services`);
      await personProbe.eventually(() => personProbe.dom('[data-testid="admin-access-state"][data-access-state="locked"], [data-testid="member-dashboard"]'), { within: 60_000, until: (value) => value.elements.length > 0, label: "Cloud Services route is denied after access resolves" });
      await person.notSee({ testId: "service-check-now" });
      const denied = await personProbe.api(session, "/v1/org/deployment-services");
      const context = await personProbe.api(session, "/v1/org");
      expect(denied.response.status).toBe(403);
      expect(context.body).toMatchObject({ canManageDeploymentServices: false });
      evidence.recordAssertionEvidence(`Cloud ${name} cannot inspect installation setup`, `Settings diagnostics=${denied.response.status}; server capability=false`, denied.response.status === 403);
      await person.screenshot();
    });
  }
  await step("the internal cloud operator retains the separate platform diagnostic surface", async () => {
    const operator = user.on(world.operator);
    await operator.navigate(`${world.den.ref.webUrl}/admin/services`);
    await operator.see({ testId: "admin-services-page" }, { timeoutMs: 60_000 });
    const response = await probe.on(world.operator).api(world.den.admin, "/v1/admin/services");
    expect(response.response.status).toBe(200);
    evidence.recordAssertionEvidence("Internal platform diagnostics remain independent", `platform inventory=${response.response.status}; no tenant Settings authority`, response.response.ok);
    await operator.screenshot();
  });
});
