import { addInitScript, browserScript, reload } from "@openwork/cdp";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

type OfflineFault = {
  disconnected: boolean;
  prompts: number;
  stops: number;
  probes: number;
  remoteCatalogs: number;
  setOffline(value: boolean): void;
};
declare global { interface Window { __offlineRecoveryFault?: OfflineFault } }

export const SAVED_PROMPT = "Keep this completed report in the conversation.";
export const SAVED_REPLY = "The completed report is preserved.";
export const RETRY_PROMPT = "Fetch the next report from the online provider.";

export function offlineRecoveryWorld(seed: Seed) { return createOfflineRecoveryWorld(seed, true); }
export function localOfflineRecoveryWorld(seed: Seed) { return createOfflineRecoveryWorld(seed, false); }

async function createOfflineRecoveryWorld(seed: Seed, onlineModel: boolean) {
  const engine = resolveEvalEngine();
  const { den, webPort } = await denForAppWeb(seed);
  const organizationId = await seededOrganizationId(seed, den.admin);
  const providerId = "offline-proof";
  const modelId = "online-report";
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
    { promptMarker: SAVED_PROMPT, latestUserTurn: true, finalReply: SAVED_REPLY, steps: [] },
    { promptMarker: RETRY_PROMPT, latestUserTurn: true, serverErrorAttempts: 3, finalReply: "Recovered report.", steps: [] },
  ] });
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, name: "offline-recovery", workspacePath: seed.tmpPath("offline-recovery"), mocks: { agent: mock },
  });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("The report model witness did not start");
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Report model",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-offline-proof" }, models: { [modelId]: { name: "Report model" } } } },
  }, engine);
  const session = await seed.session(app, { title: "Offline report recovery" });
  const registration = await addInitScript(app.client, browserScript((providerId, modelId, onlineModel) => {
    const original = window.fetch.bind(window);
    const fault: OfflineFault = window.__offlineRecoveryFault = {
      disconnected: false, prompts: 0, stops: 0, probes: 0, remoteCatalogs: 0,
      setOffline(value) {
        this.disconnected = value;
        window.dispatchEvent(new Event(value ? "offline" : "online"));
      },
    };
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => !fault.disconnected });
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname.endsWith("/v1/features") && init?.cache === "no-store") {
        fault.probes++;
        if (fault.disconnected) throw new TypeError("Failed to fetch");
      }
      const engineRequest = /\/opencode(?:2)?\//.test(url.pathname);
      if (engineRequest && method === "POST" && /\/(?:prompt(?:_async)?|message|command|shell)$/.test(url.pathname)) fault.prompts++;
      if (engineRequest && method === "POST" && /\/(?:abort|interrupt)$/.test(url.pathname)) fault.stops++;
      const response = await original(input, init);
      // The model witness runs locally. Its catalog advertises the remote URL
      // an online provider has, while its actual requests stay deterministic.
      if (onlineModel && engineRequest && method === "GET" && /\/(?:provider|model|config\/providers)$/.test(url.pathname) && response.ok) {
        const text = await response.clone().text();
        try {
          const body: unknown = JSON.parse(text);
          const visit = (value: unknown) => {
            if (!value || typeof value !== "object") return;
            const remoteApi = { id: modelId, url: "https://report-model.example.test/v1", npm: "@ai-sdk/openai-compatible" };
            if (Reflect.get(value, "id") === providerId) {
              fault.remoteCatalogs++;
              const options: unknown = Reflect.get(value, "options");
              Reflect.set(value, "options", { ...(options && typeof options === "object" ? options : {}), baseURL: remoteApi.url });
              const models: unknown = Reflect.get(value, "models");
              const model: unknown = models && typeof models === "object" ? Reflect.get(models, modelId) : null;
              if (model && typeof model === "object") Reflect.set(model, "api", remoteApi);
            }
            if (Reflect.get(value, "id") === modelId && Reflect.get(value, "providerID") === providerId) Reflect.set(value, "api", remoteApi);
            for (const entry of Object.values(value)) visit(entry);
          };
          visit(body);
          return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
        } catch { /* Non-catalog responses retain their original payload. */ }
      }
      return response;
    };
  }, [providerId, modelId, onlineModel]));
  await reload(app);
  return {
    app, workspace, session, engine,
    async enable() {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
        method: "PUT", body: JSON.stringify({ capabilities: { offlineRecovery: true } }),
      });
      if (!result.response.ok) throw new Error(`Offline recovery could not be enabled (${result.response.status})`);
      await reload(app);
    },
    offline: (value: boolean) => seed.evalIn(app, browserScript((value) => {
      if (!window.__offlineRecoveryFault) throw new Error("The connectivity fault is not installed");
      window.__offlineRecoveryFault.setOffline(value);
    }, [value])),
    counts: () => seed.evalIn(app, () => {
      const state = window.__offlineRecoveryFault;
      if (!state) throw new Error("The connectivity fault is not installed");
      return { prompts: state.prompts, stops: state.stops, probes: state.probes, remoteCatalogs: state.remoteCatalogs };
    }),
    modelRequests: () => witness.agentRequests({ promptMarker: RETRY_PROMPT }),
    async [Symbol.asyncDispose]() { await registration.dispose(); },
  };
}
