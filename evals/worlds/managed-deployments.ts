import { createOrg, type Seed } from "@openwork/env";
import type { DenSession } from "@openwork/behaviors";
import { callFunctionOnSurface } from "@openwork/cdp";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Real Den with UI-only fixture AWS and GCP release metadata. These fixture
 * URLs and checksums do not represent deployable releases. One workspace has
 * deployments on, one off, and GCP starts off until the test explicitly opts in.
 * No cloud account is touched and no installation is claimed or performed.
 */
export async function managedDeployments(seed: Seed) {
  const stamp = Date.now();
  const names = { enabled: `Deployments workspace ${stamp}`, disabled: `Deployments off ${stamp}` };
  const den = await seed.den({
    env: {
      DEN_DEPLOYMENT: "cloud", DEN_ORG_MODE: "multi_org",
      DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: "https://releases.example.test/aws/0.18.57/cloudformation.json",
      DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: "https://releases.example.test/aws/0.18.57/bundle.tar.gz",
      DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: "a".repeat(64),
      DEN_MANAGED_DEPLOYMENT_AWS_VERSION: "0.18.57",
      // UI-only: commands must never be run or mistaken for installer evidence.
      DEN_MANAGED_DEPLOYMENT_GCP_TEMPLATE_URL: "https://storage.googleapis.com/openwork-ui-only-fixture/gcp/0.18.57/tutorial.md?generation=1",
      DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_URL: "https://storage.googleapis.com/openwork-ui-only-fixture/gcp/0.18.57/bundle.tar.gz?generation=1",
      DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_SHA256: "b".repeat(64),
      DEN_MANAGED_DEPLOYMENT_GCP_VERSION: "0.18.57",
    },
    org: { name: names.enabled, admin: { name: "Deployment Owner" }, members: { member: { name: "Deployment Member" } } },
  });
  const enabledOrgId = await enableOrganizationCapabilities(seed, den.admin, { managedDeployments: true });
  const disabledOrg = await createOrg(den, names.disabled);
  const viewport = { width: 1440, height: 1000 };

  // Workspace switching needs Better Auth's cookie session, not the desktop
  // bearer that seed.web({ signedInAs }) stores.
  async function signedInBrowser(person: DenSession, organizationId: string, startPath: string) {
    const browser = await seed.web({ den, startPath: "/", headless: true, viewport });
    const signedIn = await seed.api(person, "/api/auth/sign-in/email", {
      method: "POST", headers: { origin: den.ref.webUrl },
      body: JSON.stringify({ email: person.email, password: person.password }),
    });
    const cookie = signedIn.response.headers.getSetCookie().find((value) => value.includes("session_token="))?.split(";")[0] ?? "";
    const separator = cookie.indexOf("=");
    if (!signedIn.response.ok || separator < 1) throw new Error(`Browser sign-in failed: HTTP ${signedIn.response.status}`);
    const applied = await browser.client.send("Network.setCookie", {
      name: cookie.slice(0, separator), value: cookie.slice(separator + 1),
      url: den.ref.webUrl, path: "/", httpOnly: true, secure: new URL(den.ref.webUrl).protocol === "https:",
    });
    if (!isRecord(applied) || applied.success !== true) throw new Error("Could not install the browser session cookie.");
    const selected = await seed.api(person, "/api/auth/organization/set-active", {
      method: "POST", headers: { cookie, origin: den.ref.webUrl }, body: JSON.stringify({ organizationId }),
    });
    if (!selected.response.ok) throw new Error(`Workspace selection failed: HTTP ${selected.response.status}`);
    await browser.client.send("Page.navigate", { url: new URL(startPath, den.ref.webUrl).toString() });
    return browser;
  }

  // One browser and one cookie session: local placement shares a Chrome
  // profile, so a second session would overwrite this one's cookie.
  const web = await signedInBrowser(den.admin, disabledOrg.id, "/dashboard/deployments");
  return {
    den, web, names, enabledOrgId, disabledOrgId: disabledOrg.id, baseUrl: den.ref.webUrl,
    // What an API or MCP client receives when it (re)opens a prepared launch.
    // Reopening an awaiting-approval run is idempotent: it returns the same run.
    reopenLaunch: async (organizationId: string, deploymentId: string) => {
      const result = await seed.api(den.admin, `/v1/managed-deployments/${deploymentId}/launch`, {
        method: "POST", headers: { "x-openwork-org-id": organizationId, "content-type": "application/json" }, body: JSON.stringify({ kind: "install" }),
      });
      if (!result.response.ok) throw new Error(`Reopening the launch failed: HTTP ${result.response.status}`);
      return result.body;
    },
    enableGcp: () => enableOrganizationCapabilities(seed, den.admin, { managedDeployments: true, managedDeploymentsGcp: true }, enabledOrgId),
    // Fixed, read-only text observations: probe.dom() has bounds, but does not
    // expose computed text/background colors or React text-node fragmentation.
    deploymentTextReadability: () => callFunctionOnSurface(web, () => {
      function luminance(color: string) {
        const match = color.match(/^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
        if (!match) throw new Error(`Unsupported computed text color: ${color}`);
        const channels = match.slice(1, 4).map((value) => {
          const channel = Number(value) / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      }
      function background(element: Element) {
        let parent: Element | null = element;
        while (parent) {
          const color = getComputedStyle(parent).backgroundColor;
          if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
          parent = parent.parentElement;
        }
        return "rgb(255, 255, 255)";
      }
      function sentence(selector: string) {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return null;
        const disclosure = element.closest("details");
        return {
          text: element.textContent?.trim() ?? "",
          textNodeCount: Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()).length,
          inlineChildren: element.childElementCount,
          fits: element.scrollWidth <= element.clientWidth,
          disclosed: !(disclosure instanceof HTMLDetailsElement) || disclosure.open,
        };
      }
      const steps = document.querySelector('[data-testid="managed-deployment-steps"]');
      const reference = steps?.parentElement?.querySelector("p");
      const neutralColor = reference ? getComputedStyle(reference).color : null;
      const labels = Array.from(document.querySelectorAll('[data-testid="managed-deployment-steps"] > li'), (row) => {
        const label = row.querySelector("span");
        if (!label) throw new Error("An installation check has no label.");
        const style = getComputedStyle(label);
        const foreground = luminance(style.color);
        const surface = luminance(background(label));
        return {
          text: label.textContent?.trim() ?? "",
          color: style.color,
          opacity: Number(style.opacity),
          contrast: (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05),
          pendingMarker: Boolean(row.querySelector("svg.lucide-circle-dashed")),
          otherMarker: Boolean(row.querySelector("svg:not(.lucide-circle-dashed)")),
        };
      });
      return {
        neutralColor, labels,
        consent: sentence('[data-testid="deployment-cost-consent"]'),
        setup: sentence('[data-testid="deployment-setup-directions"]'),
      };
    }, []),
    async [Symbol.asyncDispose]() { await disabledOrg[Symbol.asyncDispose](); },
  };
}
