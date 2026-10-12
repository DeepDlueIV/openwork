import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { adminOrganizationRace } from "../worlds/den-admin-organization-race.ts";

const test = spec.world(adminOrganizationRace, {
  timeout: 180_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a platform admin keeps the organization inventory when an older overview finishes", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const adminProbe = probe.on(world.web);
  const navigate = async (url: string) => {
    const before = await adminProbe.documentState(url);
    await admin.navigate(url);
    await adminProbe.eventually(() => adminProbe.documentState(url), {
      within: 30_000, label: "the new admin document is ready",
      until: state => state.sameUrl && state.complete && state.timeOrigin !== before.timeOrigin,
    });
  };
  const inventory = async () => {
    const rows = await adminProbe.dom('[data-testid^="admin-org-row-"]');
    const busy = await adminProbe.dom('[aria-busy="true"]');
    return { rows: rows.elements.length, busy: busy.elements.some(element => element.rect.width > 0 && element.rect.height > 0) };
  };

  await step("warm the real overview cache without loading organizations", async () => {
    await navigate(world.adminUrl);
    await admin.see({ role: "button", label: /Organizations \(2\)/ });
    const warmed = await adminProbe.eventually(() => world.transport.requests(), {
      within: 30_000, label: "the original overview has completed",
      until: requests => requests.some(request => request.kind === "overview" && request.completed),
    });
    expect(warmed.find(request => request.kind === "overview")).toMatchObject({ status: 200, rows: 0, total: 2, held: false });
    await navigate(world.featuresUrl);
    evidence.recordAssertionEvidence("Warm cache comes from the real server", "The authorized overview returned HTTP 200, totalOrganizations=2, with its deferred organization list empty. No response or storage was fabricated.", true);
  });

  await step("load organizations while the older overview response is held", async () => {
    world.transport.hold();
    await navigate(world.adminUrl);
    await adminProbe.eventually(() => world.transport.requests(), {
      within: 30_000, label: "the genuine refresh response is held after server authorization",
      until: requests => requests.some(request => request.kind === "overview" && request.held && !request.completed),
    });
    await admin.click({ role: "button", label: /Organizations \(2\)/ });
    await adminProbe.eventually(inventory, {
      within: 30_000, label: "both live organization rows are visible before the old overview is released",
      until: state => state.rows === 2,
    });
    expect(world.transport.requests().find(request => request.kind === "organizations")).toMatchObject({ status: 200, rows: 2, total: 2, completed: true });
    expect(world.transport.requests().filter(request => request.held).every(request => !request.completed)).toBe(true);
    evidence.recordAssertionEvidence("The newer list wins the network race", JSON.stringify({ requests: world.transport.requests(), inventory: await inventory() }), true);
    await admin.screenshot();
  });

  await step("releasing the old overview preserves the settled organization rows", async () => {
    await world.transport.release();
    const samples: Awaited<ReturnType<typeof inventory>>[] = [];
    const started = Date.now();
    await adminProbe.eventually(async () => {
      samples.push(await inventory());
      return Date.now() - started;
    }, { within: 5_000, label: "observe the rendered inventory after the late response", until: elapsed => elapsed >= 1_000 });
    const settled = await inventory();
    const requests = world.transport.requests();
    const preserved = samples.every(sample => sample.rows === 2) && settled.rows === 2 && !settled.busy;
    evidence.recordAssertionEvidence("Late overview cannot erase newer rows", JSON.stringify({ requests, samples, settled }), preserved);
    await admin.screenshot();
    expect(requests.filter(request => request.held).every(request => request.completed)).toBe(true);
    expect(settled).toEqual({ rows: 2, busy: false });
    expect(samples.every(sample => sample.rows === 2)).toBe(true);
  });
});
