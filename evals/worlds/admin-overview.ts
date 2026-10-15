import type { Seed } from "@openwork/env";

export async function adminOverviewWorld(seed: Seed) {
  const den = await seed.den({
    org: {
      name: "Overview workspace",
      admin: { name: "Overview Admin" },
      members: { member: { name: "Overview Member" } },
    },
  });
  const viewport = { width: 1280, height: 700 };
  const anonymous = await seed.web({ den, startPath: "/admin", headless: true, viewport });
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/admin", headless: true, viewport });
  const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/admin", headless: true, viewport });
  return {
    anonymous, admin, member,
    async traffic(person: "anonymous" | "admin" | "member") {
      const web = person === "anonymous" ? anonymous : person === "admin" ? admin : member;
      // TODO(primitive): probe needs a read-only resource timing projection to
      // prove the absence of eager requests without injecting product state.
      return seed.evalIn(web, () => {
        const resources = performance.getEntriesByType("resource");
        return {
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
