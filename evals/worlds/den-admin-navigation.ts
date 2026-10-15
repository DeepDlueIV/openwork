import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function adminDashboardWeb(seed: Seed) {
  const den = await seed.den({
    org: { name: `Admin navigation ${Date.now()}`, admin: { name: "Navigation Admin" } },
  });
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, { teamPageTabs: true });
  const setRemoval = async (enabled: boolean) => {
    const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
      method: "PUT", body: JSON.stringify({ capabilities: { desktopPolicyScreenRemoval: enabled } }),
    });
    if (!result.response.ok) throw new Error(`Setting desktop policy screen rollout failed: ${result.text}`);
  };
  await setRemoval(false);
  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: "/dashboard",
    headless: true,
    viewport: { width: 1440, height: 1100 },
  });
  return {
    den,
    web,
    setRemoval,
    /** The current web location's pathname and search. */
    // TODO(primitive): probe.location should expose pathname+search on web surfaces; probe.hash only covers the hash.
    async location(): Promise<string> {
      const value = await seed.evalIn(web, () => (window.location.pathname + window.location.search));
      if (typeof value !== "string") throw new Error("Expected the web location to be a string.");
      return value;
    },
    /** The page labels in the organization sidebar, excluding separate badge text. */
    // TODO(primitive): probe should list accessible link names inside a container by testId.
    async sidebarLinks(): Promise<string[]> {
      return strings(await seed.evalIn(web, () => (Array.from(document.querySelectorAll<HTMLElement>('[data-testid="den-org-sidebar"] a')).map((a) => (a.querySelector('span')?.textContent ?? a.textContent ?? '').trim()))));
    },
    /** The direct text labels of selected tabs. */
    // TODO(primitive): user.see({ role: "tab" }) cannot assert aria-selected today.
    async selectedTabs(): Promise<string[]> {
      return strings(await seed.evalIn(web, () => (Array.from(document.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="true"]')).map((tab) => Array.from(tab.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join('').trim()))));
    },
  };
}
