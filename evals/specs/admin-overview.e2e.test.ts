import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { adminOverviewWorld } from "../worlds/admin-overview.ts";

const test = spec.world(adminOverviewWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

test("an admin opens a lightweight overview while signed-out visitors see sign-in immediately", async ({ world, user, probe, step, evidence }) => {
  const anonymous = user.on(world.anonymous);
  const anonymousProbe = probe.on(world.anonymous);
  const admin = user.on(world.admin);
  const adminProbe = probe.on(world.admin);
  const member = user.on(world.member);

  await step("before: a signed-out visitor sees sign-in without a dashboard skeleton", async () => {
    await anonymous.see({ role: "heading", label: "Sign in required" });
    const skeletons = await anonymousProbe.dom('[aria-busy="true"], .animate-pulse');
    const traffic = await world.traffic("anonymous");
    const ok = skeletons.elements.length === 0 && traffic.overview === 0 && traffic.usage === 0;
    evidence.recordAssertionEvidence("Signed-out visitors never start dashboard work", `skeletons=${skeletons.elements.length}; overview requests=${traffic.overview}; usage requests=${traffic.usage}`, ok);
    expect(ok).toBe(true);
    await anonymous.screenshot();
  });

  await step("the admin reads the overview while model consumption remains below the viewport", async () => {
    await admin.see({ text: "User backoffice" }, { timeoutMs: 60_000 });
    const deferred = await adminProbe.dom('[data-admin-deferred="pending"]');
    const traffic = await world.traffic("admin");
    const ok = deferred.elements.length === 1 && deferred.elements[0].rect.top > 1100 && traffic.usage === 0 && traffic.metrics === 0;
    evidence.recordAssertionEvidence("The consumption section is outside the viewport and its preload margin", `section top=${deferred.elements[0]?.rect.top}px; viewport=700px; margin=400px; usage=${traffic.usage}; analytics=${traffic.metrics}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: scrolling to model consumption loads it once", async () => {
    await admin.wheelAt({ x: 1000, y: 500, deltaY: 1600 });
    await admin.see({ testId: "admin-usage-section" });
    const traffic = await adminProbe.eventually(() => world.traffic("admin"), { within: 15_000, until: (value) => value.usage === 1, label: "visible consumption read" });
    await admin.wheelAt({ x: 1000, y: 500, deltaY: -1600 });
    await admin.wheelAt({ x: 1000, y: 500, deltaY: 1600 });
    const repeated = await world.traffic("admin");
    const ok = traffic.usage === 1 && repeated.usage === 1;
    evidence.recordAssertionEvidence("Revisiting the section reuses the loaded consumption", `first visit=${traffic.usage}; second visit=${repeated.usage}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("the admin opens one organization's feature editor on demand", async () => {
    await admin.click({ role: "button", label: /^Organizations \(/ });
    await admin.see({ testId: "admin-organization-features" });
    const before = await adminProbe.dom('[data-testid^="admin-capability-"]');
    expect(before.elements.length).toBe(0);
    const initialTraffic = await world.traffic("admin");
    expect(initialTraffic.features).toBe(0);
    expect(initialTraffic.lightOrganizations).toBe(1);
    const payloads = await world.organizationPayloads();
    expect(payloads.fullCount).toBeGreaterThan(0);
    expect(payloads.lightCount).toBe(payloads.fullCount);
    expect(payloads.fullWithFeatures).toBe(payloads.fullCount);
    expect(payloads.lightWithFeatures).toBe(0);
    await admin.click({ testId: "admin-organization-features-toggle", nth: 0 });
    const after = await adminProbe.eventually(() => adminProbe.dom('[data-testid^="admin-capability-"]'), { within: 10_000, until: (value) => value.elements.length > 0, label: "expanded feature controls" });
    const loadedTraffic = await world.traffic("admin");
    const ok = loadedTraffic.features === 1 && after.elements.length > 0 && payloads.lightBytes < payloads.fullBytes;
    evidence.recordAssertionEvidence("Only the expanded organization fetches features, and the list omits them", `feature reads ${initialTraffic.features} → ${loadedTraffic.features}; controls ${before.elements.length} → ${after.elements.length}; page payload ${payloads.fullBytes} → ${payloads.lightBytes} characters; existing clients retain feature data`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("the admin reopens an organization's features without fetching them again", async () => {
    await admin.click({ testId: "admin-organization-features-toggle", nth: 0 });
    await adminProbe.eventually(() => adminProbe.dom('[data-testid^="admin-capability-"]'), { within: 10_000, until: (value) => value.elements.length === 0, label: "collapsed feature controls" });
    await admin.click({ testId: "admin-organization-features-toggle", nth: 0 });
    const controls = await adminProbe.eventually(() => adminProbe.dom('[data-testid^="admin-capability-"]'), { within: 10_000, until: (value) => value.elements.length > 0, label: "cached feature controls" });
    const traffic = await world.traffic("admin");
    evidence.recordAssertionEvidence("Reopening features reuses the loaded organization state", `feature reads=${traffic.features}; controls=${controls.elements.length}`, traffic.features === 1);
    expect(traffic.features).toBe(1);
    await admin.screenshot();
  });

  await step("a signed-in member without platform access still sees a locked page", async () => {
    await member.see({ role: "heading", label: "Admin access required" }, { timeoutMs: 60_000 });
    const controls = await probe.on(world.member).dom('[data-testid^="admin-user-row-"], [aria-busy="true"]');
    evidence.recordAssertionEvidence("A non-admin session never mounts the dashboard", `dashboard rows and skeletons=${controls.elements.length}`, controls.elements.length === 0);
    expect(controls.elements.length).toBe(0);
    await member.screenshot();
  });
});
