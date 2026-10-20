import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { deploymentServiceReadinessSchema } from "@openwork/types/den/service-readiness";
import { denServicesWithInfrastructure, denServicesWithoutInfrastructure } from "../worlds/den-service-readiness.ts";

const absent = spec.world(denServicesWithoutInfrastructure, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });
const configured = spec.world(denServicesWithInfrastructure, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

absent("a self-hosted administrator verifies core services without deploying optional infrastructure", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.admin), adminProbe = probe.on(world.admin);
  await step("before: the service inventory distinguishes missing optional infrastructure from failed core services", async () => {
    await admin.see({ testId: "admin-services-page" }, { timeoutMs: 60_000 });
    await admin.see({ testId: "service-status-headlessRunner" });
    await admin.see({ testId: "service-status-workbot" });
    await admin.see({ testId: "service-check-now" });
    const rows = await adminProbe.dom('[data-testid^="service-status-"]');
    expect(rows.elements).toHaveLength(7);
    evidence.recordAssertionEvidence("One inventory covers core and optional services", `service rows=${rows.elements.length}; no optional infrastructure is deployed`, rows.elements.length === 7);
    await admin.screenshot();
  });
  await step("after: Check now verifies the database while absent services stay optional", async () => {
    await adminProbe.eventually(() => adminProbe.dom('[data-testid="service-check-now"]:not(:disabled)'), {
      within: 60_000, until: (value) => value.elements.length === 1, label: "Check now is available after the initial snapshot",
    });
    await admin.click({ testId: "service-check-now" });
    await admin.see({ testId: "service-state-database" }, { text: "Ready", timeoutMs: 60_000 });
    await admin.see({ testId: "service-state-headlessRunner" }, { text: "Not set up" });
    await admin.see({ testId: "service-state-workbot" }, { text: "Not set up" });
    const response = await adminProbe.api(world.den.admin, "/v1/admin/services");
    const status = deploymentServiceReadinessSchema.parse(response.body);
    const database = status.services.find((service) => service.id === "database");
    expect(database?.state).toBe("ready");
    expect(database?.lastSuccessAt).not.toBeNull();
    expect(world.fixtureCalls()).toBe(0);
    evidence.recordAssertionEvidence("Missing optional services do not block a working self-hosted Den", `database=${database?.state}; optional service requests=${world.fixtureCalls()}`, response.response.ok && database?.state === "ready" && world.fixtureCalls() === 0);
    await admin.screenshot();
  });
  await step("the administrator can find the minimal runner setup without exposing any values", async () => {
    await admin.click({ testId: "service-details-toggle-headlessRunner" });
    await admin.see({ testId: "service-details-headlessRunner" }, { text: /DEN_HEADLESS_RUNNER_URL/ });
    await admin.see({ testId: "service-details-headlessRunner" }, { text: /DEN_HEADLESS_RUNNER_TOKEN/ });
    const details = await adminProbe.dom('[data-testid="service-details-headlessRunner"][open]');
    expect(details.elements).toHaveLength(1);
    expect(details.elements[0].text).toContain("persistent storage");
    evidence.recordAssertionEvidence("Setup requirements name settings, not credentials or automatic infrastructure changes", "Expanded runner requirements name the service URL, matching token and persistent storage; no infrastructure was provisioned", details.elements.length === 1 && details.elements[0].text.includes("DEN_HEADLESS_RUNNER_TOKEN"));
    await admin.screenshot();
    await admin.click({ testId: "service-details-toggle-headlessRunner" });
  });
  await step("ordinary members and signed-out visitors cannot inspect or probe deployment services", async () => {
    const member = user.on(world.member), anonymous = user.on(world.anonymous);
    await member.notSee({ testId: "service-check-now" });
    await anonymous.notSee({ testId: "service-check-now" });
    const denied = await probe.on(world.member).api(world.den.members.member, "/v1/admin/services");
    expect(denied.response.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain("missingSettings");
    evidence.recordAssertionEvidence("Organization membership is not deployment administrator access", `member diagnostics status=${denied.response.status}; neither persona has Check now`, denied.response.status === 403);
    await member.screenshot();
    await anonymous.screenshot();
  });
  await step("the same status rows remain usable on a narrow screen", async () => {
    await admin.resizeViewport({ width: 320, height: 740, deviceScaleFactor: 1 });
    await admin.see({ testId: "service-status-database" });
    const layout = await adminProbe.dom("body");
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    evidence.recordAssertionEvidence("Readiness does not require sideways scrolling", `document=${layout.documentWidth}px; viewport=${layout.viewportWidth}px`, layout.documentWidth <= layout.viewportWidth);
    await admin.screenshot();
  });
});

configured("an administrator verifies authenticated service health without claiming model or message delivery", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.admin), adminProbe = probe.on(world.admin);
  await step("the administrator checks configured Gateway, runner and Workbot services", async () => {
    await admin.see({ testId: "admin-services-page" }, { timeoutMs: 60_000 });
    await adminProbe.eventually(() => adminProbe.dom('[data-testid="service-check-now"]:not(:disabled)'), {
      within: 60_000, until: (value) => value.elements.length === 1, label: "Check now is available after the initial snapshot",
    });
    await admin.click({ testId: "service-check-now" });
    await admin.see({ testId: "service-state-headlessRunner" }, { text: "Ready", timeoutMs: 60_000 });
    await admin.see({ testId: "service-state-workbot" }, { text: "Ready" });
    const response = await adminProbe.api(world.den.admin, "/v1/admin/services");
    const status = deploymentServiceReadinessSchema.parse(response.body);
    const runner = status.services.find((service) => service.id === "headlessRunner");
    const workbot = status.services.find((service) => service.id === "workbot");
    expect(runner?.reason).toBe("health_verified");
    expect(workbot?.reason).toBe("health_verified");
    expect(world.fixtureCalls()).toBeGreaterThanOrEqual(3);
    expect(world.unauthorizedFixtureCalls()).toBe(0);
    expect(world.unexpectedFixtureCalls()).toBe(0);
    evidence.recordAssertionEvidence("Ready is backed by service responses, not environment presence", `runner=${runner?.reason}; Workbot=${workbot?.reason}; health calls=${world.fixtureCalls()}; unauthorized calls=${world.unauthorizedFixtureCalls()}; non-health calls=${world.unexpectedFixtureCalls()}`, runner?.reason === "health_verified" && workbot?.reason === "health_verified" && world.unauthorizedFixtureCalls() === 0 && world.unexpectedFixtureCalls() === 0);
    await admin.screenshot();
  });
  await step("optional delivery and recovery remain unverified rather than turning green from configuration alone", async () => {
    await admin.see({ testId: "service-status-slack" });
    await admin.see({ testId: "service-status-durableTurns" });
    const response = await adminProbe.api(world.den.admin, "/v1/admin/services");
    const status = deploymentServiceReadinessSchema.parse(response.body);
    const delivery = status.services.filter((service) => ["slack", "durableTurns", "email"].includes(service.id));
    expect(delivery).toHaveLength(3);
    expect(delivery.every((service) => service.state !== "ready")).toBe(true);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("readiness-fixture-service-token");
    expect(serialized).not.toContain("http://127.0.0.1");
    evidence.recordAssertionEvidence("Health checks neither send messages nor pretend to verify delivery", `delivery states=${delivery.map((service) => `${service.id}:${service.state}`).join(", ")}; no endpoint or token values in diagnostics`, delivery.length === 3 && delivery.every((service) => service.state !== "ready"));
    await admin.screenshot();
  });
  await step("members receive only the minimal shared snapshot, never deployment setting details", async () => {
    const member = user.on(world.member);
    await member.navigate(`${world.den.ref.webUrl}/dashboard`);
    await member.see({ testId: "member-dashboard" }, { timeoutMs: 60_000 });
    const response = await probe.on(world.member).api(world.den.members.member, "/v1/org");
    const body = response.body;
    const capabilities = typeof body === "object" && body !== null && "deploymentCapabilities" in body ? body.deploymentCapabilities : null;
    const serialized = JSON.stringify(capabilities);
    expect(serialized).toContain("serviceReadiness");
    expect(serialized).not.toContain("missingSettings");
    expect(serialized).not.toContain("readiness-fixture-service-token");
    evidence.recordAssertionEvidence("The member view shares status without operator diagnostics", `organization request=${response.response.status}; readiness present; missing settings and credentials absent`, response.response.ok && serialized.includes("serviceReadiness") && !serialized.includes("missingSettings"));
    await member.screenshot();
  });
});
