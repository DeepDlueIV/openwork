import { createServer } from "node:http";
import type { Seed } from "@openwork/env";

/** Real Den API, database, sign-in, feature controls and settings page. Only the outside runner catalog is synthetic. */
export function workbotLunaDefaultWorld(lunaAvailable: boolean, verified = true) {
  return async (seed: Seed) => {
    const runner = createServer((request, response) => {
      if (request.url !== "/v1/models" || request.headers.authorization !== `Bearer ${"r".repeat(32)}`) { response.writeHead(401).end(); return; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ defaultModel: "gateway/other", verified, models: [
        { id: "gateway/other", name: "Another model" },
        ...(lunaAvailable ? [{ id: "gateway/luna", name: "GPT-6 Luna" }] : []),
      ] }));
    });
    await new Promise<void>(resolve => runner.listen(0, "127.0.0.1", resolve));
    const address = runner.address();
    if (!address || typeof address === "string") throw new Error("Runner fixture did not start");
    try {
      const den = await seed.den({
        org: { name: "Model workspace", admin: { name: "Workspace Admin" } },
        env: { DEN_HEADLESS_RUNNER_URL: `http://127.0.0.1:${address.port}`, DEN_HEADLESS_RUNNER_TOKEN: "r".repeat(32) },
      });
      const org = await seed.api(den.admin, "/v1/org");
      if (typeof org.body !== "object" || org.body === null || !("organization" in org.body) || typeof org.body.organization !== "object" || org.body.organization === null || !("id" in org.body.organization) || typeof org.body.organization.id !== "string") throw new Error("Missing fixture organization");
      const organizationId = org.body.organization.id;
      const setup = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { workbot: true, workbotLunaDefault: !lunaAvailable } }) });
      if (!setup.response.ok) throw new Error(`Could not set up Workbot (${setup.response.status})`);
      const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/workbot-settings", headless: true, viewport: { width: 1280, height: 800, deviceScaleFactor: 1 } });
      return {
        web,
        settingsUrl: `${den.ref.webUrl}/dashboard/workbot-settings`,
        featureUrl: `${den.ref.webUrl}/admin/organizations/${organizationId}`,
        async [Symbol.asyncDispose]() { runner.closeAllConnections(); await new Promise<void>(resolve => runner.close(() => resolve())); },
      };
    } catch (error) { runner.closeAllConnections(); await new Promise<void>(resolve => runner.close(() => resolve())); throw error; }
  };
}
