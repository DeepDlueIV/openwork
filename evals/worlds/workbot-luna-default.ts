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
      const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/workbot-settings", headless: true, viewport: { width: 1280, height: 800, deviceScaleFactor: 1 } });
      return {
        web,
        settingsUrl: `${den.ref.webUrl}/dashboard/workbot-settings`,
        completionCount: () => runner.calls().length,
        authorizedCompletions: () => runner.calls().every(call => call.authorized),
        async [Symbol.asyncDispose]() { await runner.close(); },
      };
    } catch (error) { await runner.close(); throw error; }
  };
}
