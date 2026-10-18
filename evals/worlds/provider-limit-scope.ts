import { allocateFreePorts } from "@openwork/cdp";
import { faultProxy, type Seed } from "@openwork/env";
import { isRecord } from "./library.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export async function providerLimitScope(seed: Seed) {
  await using setup = new AsyncDisposableStack();
  const [api, webPort] = await allocateFreePorts(2);
  if (!api || !webPort) throw new Error("Missing isolated Den ports");
  const faults = setup.use(await faultProxy({ apiUrl: `http://127.0.0.1:${api}`, webUrl: `http://127.0.0.1:${webPort}` }));
  const den = setup.use(await seed.den({
    ports: { api, web: webPort }, webApiBase: faults.ref.apiUrl,
    trustedOrigins: [faults.ref.webUrl],
    org: { name: "Provider limit recovery", admin: { name: "Limit owner" } },
  }));
  await enableOrganizationCapabilities(seed, den.admin, { gatewayProviderUsageLimits: true });
  const created = await seed.api(den.admin, "/v1/inference-providers", {
    method: "POST", body: JSON.stringify({ name: "Saved model provider", providerId: "openai", modelIds: ["gpt-4o-mini"] }),
  });
  const provider = isRecord(created.body) && isRecord(created.body.inferenceProvider) ? created.body.inferenceProvider : null;
  if (!created.response.ok || typeof provider?.id !== "string") throw new Error(`Provider setup failed: ${created.response.status} ${created.text}`);
  const saved = await seed.api(den.admin, "/v1/gateway/usage-limit-policies", {
    method: "POST", body: JSON.stringify({ name: "Saved provider limit", providerId: provider.id, hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costUsd: "20" }] }),
  });
  const policy = isRecord(saved.body) && isRecord(saved.body.policy) ? saved.body.policy : null;
  if (!saved.response.ok || typeof policy?.id !== "string") throw new Error(`Limit setup failed: ${saved.response.status} ${saved.text}`);
  await faults.faults.latency("/api/den/v1/inference-providers", 4000, { times: 1 });
  await faults.faults.status("/api/den/v1/inference-providers", 503, { times: 1, body: { error: "Fixture provider lookup unavailable" } });
  const browser = await seed.web({ den, signedInAs: den.admin, startPath: `/dashboard/ai-gateway/limits/${policy.id}`, headless: true, viewport: { width: 1440, height: 1200 } });
  const owned = setup.move();
  return { den, web: browser, providerId: provider.id, policyId: policy.id, faults, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}
