import type { Seed } from "@openwork/env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function adminOverviewWorld(seed: Seed) {
  const den = await seed.den({
    org: {
      name: "Overview workspace",
      admin: { name: "Overview Admin" },
      members: { member: { name: "Overview Member" } },
    },
  });
  // A second page is a real boundary: seed 51 searchable records through the
  // product APIs instead of changing the UI's fixed 50-row page size.
  for (let value = 0; value < 51; value += 1) {
    const index = String(value).padStart(2, "0");
    const account = await fetch(`${den.ref.apiUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: den.ref.webUrl },
      body: JSON.stringify({ name: `Routing user ${index}`, email: `routing-user-${index}@example.test`, password: den.admin.password }),
    });
    if (!account.ok) throw new Error(`Routing account creation failed (${account.status}).`);
    const organization = await seed.api(den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: `Routing organization ${index}` }) });
    if (!organization.response.ok) throw new Error(`Routing organization creation failed (${organization.response.status}).`);
  }
  const viewport = { width: 1280, height: 700 };
  const anonymous = await seed.web({ den, startPath: "/admin/users?search=Routing&page=2", headless: true, viewport });
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/users", headless: true, viewport: { width: 1280, height: 200 } });
  const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/admin/organizations", headless: true, viewport });
  return {
    anonymous, admin, member,
    url(path: string) { return new URL(path, den.ref.webUrl).toString(); },
    async location() {
      // TODO(primitive): probe.hash omits URL search; navigation needs a
      // read-only projection of the pathname, search state and active link.
      return seed.evalIn(admin, () => {
        const params = new URLSearchParams(location.search);
        return { pathname: location.pathname, search: params.get("search") ?? "", page: Number(params.get("page") ?? "1"), active: document.querySelector('[data-testid="admin-navigation"] [aria-current="page"]')?.textContent?.trim() };
      });
    },
    async history(direction: "back" | "forward") {
      // TODO(primitive): user needs browser back/forward. Exercise Chromium's
      // real navigation history, without writing application or fixture state.
      const history = await admin.client.send("Page.getNavigationHistory");
      if (!isRecord(history) || !Array.isArray(history.entries) || typeof history.currentIndex !== "number") throw new Error("Browser history was unavailable.");
      const entry = history.entries[history.currentIndex + (direction === "back" ? -1 : 1)];
      if (!isRecord(entry) || typeof entry.id !== "number") throw new Error("The expected browser history entry is missing.");
      await admin.client.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    },
    async firstRow(section: "users" | "organizations", search: string, page: number) {
      const query = new URLSearchParams({ search, limit: "50", offset: String((page - 1) * 50) });
      if (section === "organizations") query.set("includeFeatures", "0");
      const result = await seed.api(den.admin, `/v1/admin/${section}?${query}`);
      if (!result.response.ok || !isRecord(result.body) || !Array.isArray(result.body[section])) throw new Error("Could not read the expected list page.");
      const first = result.body[section][0];
      if (!isRecord(first)) throw new Error("The expected list page was empty.");
      return section === "users" ? `admin-user-row-${first.id}` : `admin-org-row-${first.slug}`;
    },
    async traffic(person: "anonymous" | "admin" | "member") {
      const web = person === "anonymous" ? anonymous : person === "admin" ? admin : member;
      // TODO(primitive): probe needs a read-only resource timing projection to
      // prove the absence of eager requests without injecting product state.
      return seed.evalIn(web, () => {
        // Development Strict Mode can abort its initial read before a response.
        // Count completed responses, which correspond to data the page received.
        const resources = performance.getEntriesByType("resource").filter((entry) =>
          "responseStatus" in entry && typeof entry.responseStatus === "number" && entry.responseStatus > 0,
        );
        return {
          users: resources.filter((entry) => new URL(entry.name).pathname.endsWith("/admin/users")).length,
          overview: resources.filter((entry) => new URL(entry.name).pathname.endsWith("/admin/overview")).length,
          usage: resources.filter((entry) => new URL(entry.name).pathname.endsWith("/inference-usage")).length,
          metrics: resources.filter((entry) => new URL(entry.name).pathname.endsWith("/admin/metrics")).length,
          features: resources.filter((entry) => /\/admin\/organizations\/[^/]+\/capabilities$/.test(new URL(entry.name).pathname)).length,
          lightOrganizations: resources.filter((entry) => {
            const url = new URL(entry.name);
            return url.pathname.endsWith("/admin/organizations") && url.searchParams.get("includeFeatures") === "0";
          }).length,
        };
      });
    },
    async organizationPayloads() {
      const full = await seed.api(den.admin, "/v1/admin/organizations");
      const light = await seed.api(den.admin, "/v1/admin/organizations?includeFeatures=0");
      if (!full.response.ok || !light.response.ok) throw new Error("Could not read admin organization pages.");
      const rows = (value: unknown): Record<string, unknown>[] => {
        if (!value || typeof value !== "object" || !("organizations" in value) || !Array.isArray(value.organizations)) return [];
        return value.organizations.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
      };
      const fullRows = rows(full.body);
      const lightRows = rows(light.body);
      return {
        fullCount: fullRows.length,
        lightCount: lightRows.length,
        fullWithFeatures: fullRows.filter((row) => "capabilities" in row && "featureStates" in row).length,
        lightWithFeatures: lightRows.filter((row) => "capabilities" in row || "featureStates" in row).length,
        fullBytes: full.text.length,
        lightBytes: light.text.length,
      };
    },
  };
}
