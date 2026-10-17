import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "@openwork/cdp";
import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { isRecord } from "./openwork-server-cli.ts";

/** Real Den writes, real v2 engine, real picker. No upstream inference is sent. */
export async function liveProviderSync(seed: Seed) {
  const gatewayUrl = `http://127.0.0.1:${await allocateFreePort()}`;
  const { den, webPort } = await denForAppWeb(seed, {
    web: false,
    org: { admin: { name: "Avery Owner" }, members: { riley: { name: "Riley Member" } } },
    env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl },
  });
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, { liveProviderSync: true });
  const adminRequest = (path: string, method = "GET", body?: unknown) => denFetch(den.ref, path, {
    method,
    headers: { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": organizationId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const initialModel = "gpt-4o-mini";
  const addedModel = "gpt-4.1-mini";
  const created = await adminRequest("/v1/inference-providers", "POST", {
    name: "Live sync models", providerId: "openai", modelIds: [initialModel],
    credential: { kind: "api_key", secret: "synthetic-live-sync-upstream-key" }, allMembers: true,
  });
  const provider = isRecord(created.body) && isRecord(created.body.inferenceProvider) ? created.body.inferenceProvider : null;
  if (created.response.status !== 201 || !provider || typeof provider.id !== "string") {
    throw new Error(`Creating the real Den provider failed: ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  const providerId = provider.id;
  const groups = await adminRequest(`/v1/inference-providers/${providerId}/model-groups`);
  const group = isRecord(groups.body) && Array.isArray(groups.body.modelGroups) ? groups.body.modelGroups.find(isRecord) : null;
  if (!group || typeof group.id !== "string") throw new Error("The seeded provider has no model group");
  const groupId = group.id;
  const fixtureHostToken = randomBytes(32).toString("hex");
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, as: "riley", engine: "v2", name: "live-provider-sync", workspacePath: seed.tmpPath("live-provider-sync"),
    env: {
      // Headless Chrome receives the same test-owned bootstrap credential as
      // its server. The renderer still delivers the real signed-in session.
      OPENWORK_HOST_TOKEN: fixtureHostToken,
      VITE_OPENWORK_HOST_TOKEN: fixtureHostToken,
      // A five-second pass must not be ordinary periodic sync in disguise.
      OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "600000",
      ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
    },
  });
  const session = await seed.session(app, { title: "Organization models arrive live" });
  const paths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
  const manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
  if (!manifest) throw new Error("Missing owned app runtime manifest");
  const minted = await fetch(`${app.openworkUrl}/tokens`, {
    method: "POST", headers: { "X-OpenWork-Host-Token": manifest.hostToken, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "owner", label: "live-provider-sync-proof" }),
  });
  const owner: unknown = await minted.json();
  if (!minted.ok || !isRecord(owner) || typeof owner.token !== "string") throw new Error("Could not mint the app observer token");
  const token = owner.token;
  await app.client.send("Performance.enable");
  return {
    app, den, workspace, session, providerId, initialModel, addedModel,
    pickerRows: `[data-testid="composer-model-picker"] [data-model-key^="${providerId}:"]`,
    async documentIdentity() {
      const metrics = await app.client.send("Performance.getMetrics");
      const navigation = isRecord(metrics) && Array.isArray(metrics.metrics) ? metrics.metrics.find((metric) => isRecord(metric) && metric.name === "NavigationStart") : null;
      if (!isRecord(navigation) || typeof navigation.value !== "number") throw new Error("Missing browser navigation witness");
      return navigation.value;
    },
    async runtime() {
      const result = await fetch(`${app.openworkUrl}/experimental/engine-v2-preview/status`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
      const body: unknown = await result.json();
      if (!isRecord(body) || body.liveProviderSync === true) return isRecord(body) ? body : {};
      const sync = await fetch(`${app.openworkUrl}/cloud-provider-sync/status`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
      const syncStatus: unknown = await sync.json();
      const member = den.members.riley;
      if (!member) throw new Error("Missing signed-in member");
      const desktop = await denFetch(den.ref, "/v1/me/desktop-config", { headers: {
        authorization: `Bearer ${member.token}`, "x-openwork-org-id": organizationId,
      } });
      return { ...body, syncStatus, denLiveProviderSync: isRecord(desktop.body) ? desktop.body.liveProviderSync : null };
    },
    /** The authenticated admin makes the same write as Den's Add models action. */
    async addModel() {
      const startedAt = Date.now();
      const result = await adminRequest(`/v1/inference-providers/${providerId}/enable-models`, "POST", { modelGroupId: groupId, modelIds: [addedModel] });
      if (!result.response.ok) throw new Error(`The admin could not add a model: ${result.response.status} ${result.text.slice(0, 500)}`);
      return { startedAt, status: result.response.status, body: result.body };
    },
    async disableProvider() {
      const startedAt = Date.now();
      const result = await adminRequest(`/v1/inference-providers/${providerId}`, "PATCH", { status: "disabled" });
      if (!result.response.ok) throw new Error(`The admin could not disable the provider: ${result.response.status} ${result.text.slice(0, 500)}`);
      return { startedAt, status: result.response.status };
    },
  };
}
