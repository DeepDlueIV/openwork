import { connect, debuggerUrlFor, listTargets } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { redirectDiscoveryMock } from "./mcp-redirect-discovery.ts";

export async function redirectSignInWeb(seed: Seed) {
  const mock = await redirectDiscoveryMock();
  mock.setMode("missing");
  try {
    const den = await seed.den({
      env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1" },
      org: { name: "exp-mcpredirect-browser", admin: { name: "Connections Admin" } },
    });
    await seed.orgConnection(den.admin, {
      name: "exp-mcpredirect-provider", url: mock.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true },
    });
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/your-connections", headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den, web, mock,
      async signInTab(): Promise<Surface | undefined> {
        const target = (await listTargets(web.handle.cdpUrl)).find((entry) => entry.type === "page" && entry.id !== web.client.targetId && entry.url.startsWith(`${den.ref.webUrl}/connect/oauth`));
        return target ? { handle: web.handle, client: await connect(debuggerUrlFor(web.handle.cdpUrl, target)) } : undefined;
      },
      async sizeSignInTab(tab: Surface) {
        await tab.client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
      },
      async healthySignInLayout(tab: Surface): Promise<boolean> {
        // Read-only geometry: a screenshot must not silently capture a clipped or overlaid error.
        const result = await tab.client.send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
          const heading = document.querySelector('h1');
          if (!heading) return false;
          const box = heading.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth
            && document.documentElement.scrollWidth <= innerWidth
            && !document.querySelector('[role="dialog"], [aria-modal="true"]');
        })()` });
        return result.result.value === true;
      },
      async [Symbol.asyncDispose]() { await mock.stop(); },
    };
  } catch (error) { await mock.stop(); throw error; }
}
