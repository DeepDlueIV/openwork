import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrgAccessFlags, getServicesRoute, parseOrgContextPayload } from "../../_lib/den-org";
import { canOpenAdminRoute } from "./admin-route-access";
import { buildDashboardNavSections, flattenNavigationForSearch, type BuildDashboardNavSectionsInput } from "./dashboard-navigation";

function context(capability: unknown) {
  return parseOrgContextPayload({
    organization: { id: "org", name: "Workspace", slug: "workspace" },
    currentMember: { id: "member", userId: "user", role: "member", permissions: [] },
    canManageDeploymentServices: capability,
  });
}

test("deployment services capability parses only literal true and never follows roles or feature maps", () => {
  assert.equal(context(true)?.canManageDeploymentServices, true);
  for (const value of [undefined, null, false, "true", 1, {}, []]) {
    assert.equal(context(value)?.canManageDeploymentServices, false);
  }
  for (const role of ["owner", "admin", "member"]) {
    const parsed = parseOrgContextPayload({
      organization: { id: "org", name: "Workspace", slug: "workspace" },
      currentMember: { id: "member", userId: "user", role, isOwner: role === "owner" },
      features: { serviceReadiness: true },
    });
    assert.equal(parsed?.canManageDeploymentServices, false);
  }
});

test("direct service route requires explicit capability, not an organization permission", () => {
  assert.equal(getServicesRoute("workspace"), "/dashboard/services");
  for (const role of ["owner", "admin", "member"]) {
    const access = getOrgAccessFlags(role, role === "owner", []);
    assert.equal(canOpenAdminRoute(getServicesRoute(), access), false);
    assert.equal(canOpenAdminRoute(getServicesRoute(), access, false), false);
    assert.equal(canOpenAdminRoute(getServicesRoute(), access, true), true);
    assert.equal(canOpenAdminRoute(`${getServicesRoute()}/other`, access, true), false);
  }
  const member = getOrgAccessFlags("member", false, []);
  assert.equal(member.canViewSettings, false);
  for (const path of ["/dashboard/org-settings", "/dashboard/billing", "/dashboard/api-keys", "/dashboard/diagnostics", "/dashboard/permissions"]) {
    assert.equal(canOpenAdminRoute(path, member, true), false);
  }
  const billingMember = getOrgAccessFlags("member", false, ["billing.view"]);
  assert.equal(canOpenAdminRoute("/dashboard/billing", billingMember, true), true);
  assert.equal(canOpenAdminRoute("/dashboard/diagnostics", billingMember, true), false);
});

test("sidebar and independently built palette expose only Settings Services for a local operator", () => {
  for (const role of ["owner", "admin", "member"]) {
    const input: BuildDashboardNavSectionsInput = {
      orgSlug: "workspace", access: getOrgAccessFlags(role, role === "owner", []),
      capabilities: { auditLogs: false, installLinks: false, mcpConnections: false, workflows: false, openworkWeb: false, cloud: false },
      orgMode: "single_org", runtimeConfigLoaded: true,
    };
    assert.ok(!flattenNavigationForSearch(buildDashboardNavSections(input)).some((item) => item.href === getServicesRoute()));
    const sidebar = buildDashboardNavSections({ ...input, canManageDeploymentServices: true });
    assert.ok(sidebar.flatMap((section) => section.items).find((item) => item.label === "Settings")?.children?.some((child) => child.label === "Services"));
    const palette = flattenNavigationForSearch(buildDashboardNavSections({ ...input, canManageDeploymentServices: true }));
    assert.equal(palette.filter((item) => item.href === getServicesRoute()).length, 1);
    assert.equal(palette.find((item) => item.href === getServicesRoute())?.label, "Settings › Services");
    if (role === "member") assert.deepEqual(palette.filter((item) => item.label.startsWith("Settings")).map((item) => item.label), ["Settings › Services"]);
  }
});
