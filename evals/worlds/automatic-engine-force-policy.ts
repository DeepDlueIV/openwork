import { randomUUID } from "node:crypto";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { browserScript } from "@openwork/cdp";

export const newV2HistoryText = "This reply was written only after switching to OpenCode v2.";
export const newV2Prompt = "Add the new engine checkpoint to this project note.";
export const continuedWorkPrompt = "Continue the project note on the current engine.";
export const continuedWorkText = "The original engine still handles this work.";
export const retainedHistoryText = "Keep this project note readable when the organization changes its engine policy.";

interface EngineStatus {
  engineOrigin: string;
  engineForced: boolean;
  chatRouting: boolean;
  running: boolean;
  version?: string;
  automaticRetryAt?: number;
  migration: { state: string; imported: number; total: number; backupPath?: string };
}

export async function failedEngineForcePolicy(seed: Seed) {
  return engineForcePolicyWorld(seed, { unavailableV2: true });
}

export async function automaticEngineForcePolicy(seed: Seed) {
  return engineForcePolicyWorld(seed);
}

async function engineForcePolicyWorld(seed: Seed, options: { unavailableV2?: boolean } = {}) {
  const token = randomUUID();
  const hostToken = randomUUID();
  const app = await seed.appWeb({
    name: "automatic-engine-force-policy",
    workspacePath: seed.tmpPath("automatic-engine-force-policy"),
    engine: "v1",
    mocks: { agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
      { promptMarker: newV2Prompt, finalReply: newV2HistoryText, steps: [] },
      { promptMarker: continuedWorkPrompt, finalReply: continuedWorkText, steps: [] },
    ] }) },
    env: {
      ...(options.unavailableV2 ? { OPENWORK_OPENCODE2_BIN: "/unavailable-fixture-engine/opencode2" } : {}),
      OPENWORK_TOKEN: token,
      OPENWORK_HOST_TOKEN: hostToken,
      OPENWORK_ENGINE_V2_PREVIEW: "",
      OPENWORK_ENGINE_FORCE_POLICY: "1",
      OPENWORK_ENGINE_AUTO_UPGRADE: "0",
      OPENWORK_FRESH_INSTALL_ENGINE: "v1",
    },
  });
  const workspace = await seed.workspace(app, app.workspaceRoot);
  const model = app.mocks.agent;
  if (!model) throw new Error("The isolated model witness was not started");
  await configureProvider(seed, app, workspace.workspaceId, "engine-history", "history-model", {
    provider: { "engine-history": { npm: "@ai-sdk/openai-compatible", name: "History model",
      options: { baseURL: `${model.url}/v1`, apiKey: "sk-local-history" }, models: { "history-model": { name: "History model" } } } },
  }, "v1");
  const session = await seed.session(app, { title: "A project note that survives engine policy changes" });
  async function request(path: string, init: { method?: string; body?: string } = {}, expectedStatus?: number) {
    // App-web's host URL is sandbox-loopback on remote placements. Use the
    // browser's network, not the runner's localhost. This escape hatch calls
    // shipping authenticated HTTP APIs only; it never reads/writes UI state.
    const result = await seed.evalIn(app, browserScript(async (url, token, hostToken, init) => {
      const response = await fetch(url, { ...init, headers: {
        Authorization: `Bearer ${token}`, "x-openwork-host-token": hostToken, "Content-Type": "application/json",
      } });
      return { status: response.status, text: await response.text() };
    }, [`${app.openworkUrl}${path}`, token, hostToken, init]), { awaitPromise: true, timeoutMs: 30_000 });
    if (result.status !== expectedStatus && (result.status < 200 || result.status >= 300)) throw new Error(`${init.method ?? "GET"} ${path}: ${result.status} ${result.text}`);
    return new Response(result.status === 204 ? null : result.text, { status: result.status });
  }
  const sessionPath = `/workspace/${workspace.workspaceId}/opencode/session/${session.sessionId}`;
  // The real v1 prompt API supports noReply: arrange persisted user history
  // without a provider call or a mock engine, before the person's first act.
  await request(`${sessionPath}/message`, {
    method: "POST",
    body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: retainedHistoryText }] }),
  });
  return {
    app,
    session,
    async status(): Promise<EngineStatus> {
      const response = await request("/experimental/engine-v2-preview/status");
      return response.json();
    },
    async messages(): Promise<string> {
      const status: EngineStatus = await (await request("/experimental/engine-v2-preview/status")).json();
      const path = status.chatRouting
        ? `/workspace/${workspace.workspaceId}/opencode2/api/session/${session.sessionId}/message`
        : `${sessionPath}/message`;
      return (await request(path)).text();
    },
    async originalMessages(): Promise<string> {
      return (await request(`${sessionPath}/message`)).text();
    },
    async manualRetry(): Promise<{ status: number; body: string }> {
      const response = await request("/experimental/engine-v2-preview/migrate", {
        method: "POST", body: JSON.stringify({ confirm: true, allowActiveSessions: true }),
      }, 409);
      return { status: response.status, body: await response.text() };
    },
    // These are the shipping host/client APIs, not browser state setters.
    async setOrganizationPolicy(upgrade: boolean): Promise<void> {
      await request("/experimental/engine-v2-preview/force", { method: "POST", body: JSON.stringify({ upgrade }) });
    },
    async chooseV2Manually(): Promise<void> {
      await request("/experimental/engine-v2-preview", { method: "PUT", body: JSON.stringify({ enabled: true, chatRouting: true }) });
    },
  };
}
