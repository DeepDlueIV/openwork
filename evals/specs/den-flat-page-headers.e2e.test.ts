import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denFlatPageHeaders, isRecord, type HeaderMeasurements } from "../worlds/den-flat-page-headers.ts";
import { isEmulatedClientWidth } from "../worlds/library.ts";

const test = spec.world(denFlatPageHeaders, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

function roster(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.members) || !Array.isArray(body.teams)) {
    throw new Error("The organization read did not return its members and teams.");
  }
  const byId = (rows: unknown[]) => rows.filter(isRecord).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return JSON.stringify({ members: byId(body.members), teams: byId(body.teams) });
}

function readableFlatHeading(measured: HeaderMeasurements, title: string, width: number) {
  expect(measured.title).toBe(title);
  expect(measured.flat).toBe(true);
  expect(measured.fontSize).toBeGreaterThan(0);
  expect(measured.fontSize).toBeLessThanOrEqual(20);
  expect(measured.fontWeight).toBe(600);
  expect(measured.inkLuminance).toBeLessThan(0.1);
  expect(measured.semanticInkMatch).toBe(true);
  expect(measured.contrast).toBeGreaterThanOrEqual(4.5);
  expect(measured.headerHeight).toBeLessThanOrEqual(40);
  expect(measured.headerImages).toEqual([]);
  expect(measured.canvasCount).toBe(0);
  expect(measured.textOverflow).not.toBe("ellipsis");
  expect(measured.heading.width).toBeGreaterThan(0);
  expect(measured.heading.left).toBeGreaterThanOrEqual(0);
  expect(measured.heading.right).toBeLessThanOrEqual(width);
  expect(measured.heading.scrollWidth).toBeLessThanOrEqual(measured.heading.clientWidth);
  expect(isEmulatedClientWidth(measured.widths.viewport, width)).toBe(true);
  expect(measured.widths.document).toBeLessThanOrEqual(measured.widths.viewport);
  expect(measured.widths.main.scroll).toBeLessThanOrEqual(measured.widths.main.client);
  expect(measured.widths.shell.scroll).toBeLessThanOrEqual(measured.widths.shell.client);
}

function typographyEvidence(measured: HeaderMeasurements): string {
  return `“${measured.title}”: ${measured.fontSize}px, ${measured.contrast.toFixed(2)}:1 contrast, semantic ink=${measured.semanticInkMatch}; heading ${measured.heading.width}×${measured.heading.height}px, ${measured.heading.scrollWidth}/${measured.heading.clientWidth}px scroll/client width; header ${measured.headerHeight}px; ${measured.canvasCount} canvases and ${measured.headerImages.length} background images; document ${measured.widths.document}/${measured.widths.viewport}px.`;
}

// Use the actual Members, provider, and Analytics routes. Compact page titles are
// the only presentation; another workspace of the same owner gets them too.
test("an owner gets compact, readable page titles in every workspace without changing its data or navigation", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const context = () => probe.api(world.den.admin, "/v1/org", { headers: world.scope });
  let originalRoster = "";
  let originalNavigation: string[] = [];
  let originalAnalyticsNavigation: string[] = [];

  // The switcher shows the choice at once; Den makes it the browser session's workspace a moment later.
  const waitForActiveWorkspace = (organizationId: string) => page.eventually(async () => {
    const listed = await probe.api(world.owner, "/v1/me/orgs");
    return isRecord(listed.body) ? listed.body.activeOrgId : undefined;
  }, { within: 30_000, label: "the chosen workspace to become the session's active workspace", until: (active) => active === organizationId });

  await step("the owner's Members page has a readable compact title without a decorative banner", async () => {
    await owner.see({ role: "heading", label: "Members" }, { timeoutMs: 90_000 });
    await owner.see({ role: "tab", label: /^Members/ });
    await owner.see({ role: "tab", label: /^Teams/ });
    await owner.see({ text: "Header Member" });
    await owner.see({ text: "Invite teammates, adjust roles, and keep access clean." });
    const before = await context();
    expect(before.response.ok).toBe(true);
    originalRoster = roster(before.body);
    originalNavigation = (await page.dom('[data-testid="den-org-sidebar"] a')).elements.map((entry) => entry.text);
    expect(originalNavigation.length).toBeGreaterThan(0);
    const measured = await world.measurements();
    readableFlatHeading(measured, "Members", 1280);
    expect((await page.dom("[data-dashboard-hero]")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("the page header has measurable dark ink on the plain page", `${typographyEvidence(measured)} Members and Teams, supporting context, navigation destinations, and the roster are present.`, true);
    await owner.screenshot();
  });

  await step("Usage & adoption uses the shared compact title and keeps its refresh action", async () => {
    await owner.navigate(world.url("/dashboard/analytics"));
    await owner.see({ role: "heading", label: "Usage & adoption" }, { timeoutMs: 60_000 });
    await owner.see({ role: "button", label: "Refresh analytics" });
    await owner.see({ role: "link", label: "Plugins & connectors" });
    await owner.see({ role: "heading", label: "Usage & adoption" });
    const measured = await world.measurements();
    readableFlatHeading(measured, "Usage & adoption", 1280);
    originalAnalyticsNavigation = (await page.dom('main nav[aria-label="Analytics views"] a')).elements.map((entry) => entry.text);
    expect(originalAnalyticsNavigation.length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("the Analytics header uses the same compact title", `${typographyEvidence(measured)} Refresh analytics and every existing Analytics destination remain; tab and metric colors are outside this heading-only change.`, true);
    await owner.screenshot();
  });

  await step("the same owner's Plugins & connectors title is 20px semantic ink with its state line intact", async () => {
    await owner.navigate(world.url("/dashboard/analytics/library"));
    await owner.see({ testId: "library-usage-toolbar" }, { timeoutMs: 60_000 });
    await owner.see({ role: "heading", label: "Plugins & connectors" });
    const measured = await world.measurements();
    readableFlatHeading(measured, "Plugins & connectors", 1280);
    expect(measured.fontSize).toBe(20);
    const report = await probe.api(world.den.admin, "/v1/library-usage/plugins?days=30", { headers: world.scope });
    expect(report.response.status).toBe(200);
    expect((await page.dom('main nav[aria-label="Analytics views"] a')).elements.map((entry) => entry.text)).toEqual(originalAnalyticsNavigation);
    const caption = (await page.dom("main header > div > div > div:last-child")).elements;
    expect(caption).toHaveLength(1);
    expect(caption[0].rect.height).toBeGreaterThanOrEqual(16);
    expect(roster((await context()).body)).toBe(originalRoster);
    evidence.recordAssertionEvidence("the Library usage title is compact and keeps its report and reserved state line", `${typographyEvidence(measured)} The plugin report returns HTTP ${report.response.status}; its controls, Analytics destinations, and ${caption[0].rect.height}px state line are present.`, true);
    await owner.screenshot();
  });

  await step("the provider page uses the same compact heading and keeps its provider controls", async () => {
    await owner.navigate(world.url("/dashboard/custom-llm-providers"));
    await owner.see({ role: "heading", label: "Bring your Own Keys" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "models-access-card" });
    await owner.see({ role: "link", label: "Add Provider" });
    await owner.see({ placeholder: "Search providers or models..." });
    await owner.see({ role: "heading", label: "Bring your Own Keys" });
    const measured = await world.measurements();
    readableFlatHeading(measured, "Bring your Own Keys", 1280);
    expect(measured.description).toContain("choose the exact models each one exposes");
    evidence.recordAssertionEvidence("the shared header leaves provider setup and model access intact", `${typographyEvidence(measured)} Add Provider, provider search, model-access choices, and credential context remain on the real provider page.`, true);
    await owner.screenshot();
  });

  await step("the provider title remains readable and does not overflow a 390px viewport", async () => {
    await owner.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await owner.see({ role: "link", label: "Add Provider" });
    await owner.see({ role: "heading", label: "Bring your Own Keys" });
    const measured = await world.measurements();
    readableFlatHeading(measured, "Bring your Own Keys", 390);
    evidence.recordAssertionEvidence("the compact provider header fits both its container and the narrow page", `${typographyEvidence(measured)} Main scroll/client width=${measured.widths.main.scroll}/${measured.widths.main.client}px; page shell=${measured.widths.shell.scroll}/${measured.widths.shell.client}px. No truncation or horizontal overflow.`, true);
    await owner.screenshot();
  });

  await step("another workspace also has the compact Members title and only its own roster", async () => {
    await owner.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await owner.click({ testId: "workspace-switcher-trigger" });
    await owner.click({ role: "button", label: new RegExp(`^${world.names.otherWorkspace}`) });
    // The trigger also carries the workspace initials and role around its name.
    await owner.see({ testId: "workspace-switcher-trigger" }, { text: new RegExp(`(^|\\n)${world.names.otherWorkspace}(\\n|$)`), timeoutMs: 60_000 });
    await waitForActiveWorkspace(world.otherOrgId);
    await owner.navigate(world.url("/dashboard/members"));
    await owner.see({ role: "heading", label: "Members" }, { timeoutMs: 60_000 });
    await owner.notSee({ text: "Header Member" });
    const other = await probe.api(world.den.admin, "/v1/org", { headers: { "x-openwork-org-id": world.otherOrgId } });
    expect(other.response.ok).toBe(true);
    const measured = await world.measurements();
    readableFlatHeading(measured, "Members", 1280);
    expect(roster((await context()).body)).toBe(originalRoster);
    evidence.recordAssertionEvidence("compact titles do not leak another workspace's roster", `${typographyEvidence(measured)} Header Member is absent in the other workspace; the original workspace's roster is unchanged.`, true);
    await owner.screenshot();
  });
});
