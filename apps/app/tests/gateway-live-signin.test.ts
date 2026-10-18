import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { initializeDenBootstrapConfig, setDenBootstrapConfig, writeDenSettings } from "../src/app/lib/den";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { connectGatewayProvider } from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

beforeEach(async () => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
  await initializeDenBootstrapConfig();
  await setDenBootstrapConfig({ baseUrl: "https://den.example.test", apiBaseUrl: "https://den.example.test" });
  writeDenSettings({ baseUrl: "https://den.example.test", apiBaseUrl: "https://den.example.test",
    authToken: "fixture-session", activeOrgId: "org-fixture" }, { persistBootstrap: false });
});
afterEach(async () => {
  getReactQueryClient().clear();
  await GlobalRegistrator.unregister();
});

const model = { providerID: "ipr_fixture", modelID: "gwm_catalog_set" };
const provider = { cloudProviderId: "ipr_fixture", providerId: "ipr_fixture", credentialSetId: "gcs_set", name: "Provider", authUrl: null };
const alias = { id: model.modelID, name: "Model", config: { id: model.modelID }, upstreamModelId: "catalog", modelGroupId: "group",
  modelGroupName: "Group", credentialSetId: "gcs_set", credentialSetName: "Set" };

for (const scenario of ["ready", "locked", "wrong-model", "wrong-set", "stale-native", "failed-auth", "changed-account", "aborted", "legacy-ready", "legacy-reloading", "provider-ready", "legacy-provider-ready", "legacy-provider-reloading"] ) {
  test(`live sign-in confirms only fresh authorization and the requested native identity: ${scenario}`, async () => {
    const requests: string[] = [];
    const controller = new AbortController();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname.replace(/^\/api\/den/, "");
      requests.push(`${request.method} ${path}`);
      if (path === "/den-session") return Response.json({ ok: true });
      if (path === "/experimental/engine-v2-preview/status") return Response.json({ enabled: true, running: true, chatRouting: true, liveProviderSync: !scenario.startsWith("legacy"),
        mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [] });
      if (path === "/cloud-provider-sync/run") return Response.json({ status: "applied" });
      if (path === "/cloud-provider-sync/status") return Response.json({ hasSession: true,
        reloadPending: scenario.endsWith("reloading"), skippedProviders: [],
        providers: [{ cloudProviderId: provider.cloudProviderId, providerId: provider.providerId, sourceProviderId: "openai", name: "Provider", modelIds: [model.modelID] }] });
      if (path === "/v1/llm-providers") return Response.json({ llmProviders: [] });
      if (path === "/v1/inference-providers") {
        if (scenario === "aborted") controller.abort();
        if (scenario === "changed-account") writeDenSettings({ baseUrl: "https://den.example.test", authToken: "other-session", activeOrgId: "org-other" }, { persistBootstrap: false });
        if (scenario === "failed-auth") return Response.json({ message: "Unavailable" }, { status: 503 });
        return Response.json({ inferenceProviders: [{ ...provider, id: provider.cloudProviderId, source: "openwork_gateway", modelAssignmentsComplete: true,
          credentialStatus: scenario === "locked" ? "member_auth_required" : "ready", models: scenario === "locked" ? [] : [alias],
          authorizationRequests: scenario === "locked" ? [{ credentialSetId: "gcs_set", name: "Set", authUrl: "https://auth.example.test", models: [alias] }] : [] }] });
      }
      if (path === "/opencode2/api/model") return Response.json({ data: scenario === "stale-native" ? [] : [{ id: model.modelID, providerID: model.providerID, name: "Model" }] });
      if (path === "/opencode2/api/provider") return Response.json({ data: [{ id: model.providerID, name: "Provider" }] });
      return Response.json({});
    });
    const server = createOpenworkServerClient({ baseUrl: "http://localhost:8787", hostToken: "fixture-host" });
    const client = createClientV2("http://localhost:8787/opencode2", "/workspace", {});
    let catalog: Awaited<ReturnType<typeof client.provider.list>>["data"];
    const store = createProviderAuthStore({ client: () => client,
      providers: () => catalog?.all ?? [], providerDefaults: () => ({}), providerConnectedIds: () => catalog?.connected ?? [], disabledProviders: () => [],
      checkDesktopAppRestriction: () => false,
      selectedWorkspaceDisplay: () => ({ id: "workspace", name: "Workspace", path: "/workspace", preset: "default", workspaceType: "local" }),
      providerBaseUrl: () => "http://localhost:8787/opencode2", selectedWorkspaceRoot: () => "/workspace", runtimeWorkspaceId: () => "workspace",
      openworkServer: { getSnapshot: () => ({ openworkServerStatus: "connected", openworkServerClient: server,
        openworkServerCapabilities: { providerSync: true }, openworkServerAuth: { hostToken: "fixture-host" } }) },
      setProviders: (all) => { catalog = { all, connected: catalog?.connected ?? [], default: {} }; },
      setProviderDefaults: () => {}, setProviderConnectedIds: (connected) => { catalog = { all: catalog?.all ?? [], connected, default: {} }; }, setDisabledProviders: () => {},
      markOpencodeConfigReloadRequired: () => {},
    });
    try {
      let confirmed = false;
      const requested = scenario.includes("provider-") ? undefined : scenario === "wrong-model" ? { ...model, modelID: "gwm_other_set" } : model;
      const target = scenario === "wrong-set" ? { ...provider, credentialSetId: "gcs_other" } : provider;
      const result = await connectGatewayProvider({ provider: target, signal: controller.signal,
        startOAuth: async () => ({ authorizationUrl: "https://auth.example.test" }), openUrl: () => {},
        resync: async () => { confirmed = await store.confirmGatewayProviderConnection(target, requested, controller.signal); },
        isConnected: () => confirmed, wait: async () => {}, attempts: 1 });
      expect(result).toBe(scenario === "ready" || scenario.endsWith("-ready"));
      expect(requests).toContain("PUT /den-session");
      if (scenario.startsWith("legacy")) {
        expect(requests).toContain("POST /cloud-provider-sync/run");
        expect(requests).toContain("GET /cloud-provider-sync/status");
      } else {
        expect(requests).toContain("GET /v1/inference-providers");
        expect(requests.some((request) => request.includes("/cloud-provider-sync/run"))).toBe(false);
        // Live completion does not depend on materialized imports or legacy usage verification.
        expect(store.getSnapshot().gatewayUsageProviderScope).toBeNull();
        expect(store.getSnapshot().importedCloudProviders).toEqual({});
      }
    } finally {
      store.dispose(); fetch.mockRestore();
    }
  });
}
