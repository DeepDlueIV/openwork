import { addInitScript, browserScript } from "@openwork/cdp";
import type { CdpClient } from "@openwork/cdp";

/**
 * Answers the page's install-config reads with a cloud install that requires
 * sign-in. Session hydration, navigation and grants still use the real Den.
 */
export function stubInstallConfig(client: CdpClient, webUrl: string, apiUrl: string) {
  return addInitScript(client, browserScript((_webUrl, apiUrl) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname !== "/v1/install-config" && url.pathname !== "/v1/me/install-config") {
        return originalFetch(input, init);
      }
      return Response.json({
        appName: "OpenWork", clientName: "Install Journey", requireSignin: true,
        logoUrl: null, iconUrl: null, desktopVersion: "0.18.0", distribution: "cloud",
        // A session-backed local/preview install must not jump to a configured hosted default.
        webUrl: "https://app.openworklabs.com",
        apiUrl,
      });
    };
  }, [webUrl, apiUrl]));
}
