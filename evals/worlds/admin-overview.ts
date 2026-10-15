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
        };
      });
    },
  };
}
