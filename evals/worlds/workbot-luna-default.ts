import type { Seed } from "@openwork/env";
import { modelProbeFixture, type ProbeFixtureMode } from "../../ee/apps/headless-runner/scripts/model-probe-fixture.ts";

/** Real Den, runner and model adapter. Only the outside model provider is a synthetic localhost fixture. */
export function workbotLunaDefaultWorld(lunaAvailable: boolean, verified = true, completion: ProbeFixtureMode = "answered") {
  return async (seed: Seed) => {
    const runner = await modelProbeFixture({ lunaAvailable, catalogVerified: verified, mode: completion, protocol: "openai-responses" });
    try {
      const den = await seed.den({
        org: { name: "Model workspace", admin: { name: "Workspace Admin" } },
        env: { DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "r".repeat(32) },
      });
      const org = await seed.api(den.admin, "/v1/org");
      if (typeof org.body !== "object" || org.body === null || !("organization" in org.body) || typeof org.body.organization !== "object" || org.body.organization === null || !("id" in org.body.organization) || typeof org.body.organization.id !== "string") throw new Error("Missing fixture organization");
      const organizationId = org.body.organization.id;
      const setup = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { workbot: true, workbotLunaDefault: !lunaAvailable || !verified || completion !== "answered" } }) });
      if (!setup.response.ok) throw new Error(`Could not set up Workbot (${setup.response.status})`);
      const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/workbot-settings", headless: true, viewport: { width: 1280, height: 800, deviceScaleFactor: 1 } });
      return {
        web,
        settingsUrl: `${den.ref.webUrl}/dashboard/workbot-settings`,
        featureUrl: `${den.ref.webUrl}/admin/organizations/${organizationId}`,
        completionCount: () => runner.calls().length,
        authorizedCompletions: () => runner.calls().every(call => call.authorized),
        async [Symbol.asyncDispose]() { await runner.close(); },
      };
    } catch (error) { await runner.close(); throw error; }
  };
}
