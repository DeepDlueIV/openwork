import type { Seed } from "@openwork/env";
import { desktop } from "@openwork/hosts";
import { browserScript } from "@openwork/cdp";
import { control, engineSessionProbe, evalIn, quitDesktop } from "@openwork/behaviors";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export async function engineUpgradeStartup(seed: Seed) {
  const den = await seed.den({ web: true });
  const profileDir = seed.tmpPath("engine-upgrade-startup-profile");
  const workspacePath = seed.tmpPath("retained-project");
  const app = await seed.desktop({ den, as: "admin", profileDir, workspacePath, env: { OPENWORK_ENGINE_V2_PREVIEW: "0" } });
  // Arrange real persisted history, not a model-dependent first-send UI turn.
  // A cold engine can still be starting after the renderer becomes interactive.
  const history = engineSessionProbe({ engine: "v1", surface: app, workspaceId: app.workspaceId });
  const deadline = Date.now() + 60000;
  while (true) {
    try { if ((await history.list(1)).ok) break; } catch (error) { if (Date.now() >= deadline) throw error; }
    if (Date.now() >= deadline) throw new Error("The initial v1 engine did not become ready");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const created = await history.create(workspacePath, "Retained project note");
  if (!created.ok || !created.data) throw new Error(`Creating retained history: HTTP ${created.status}`);
  const session = created.data;
  const note = "Keep this note readable while deciding whether to upgrade chats.";
  await evalIn(app, browserScript(async (workspace, sessionId, text) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info?.baseUrl) throw new Error("Local host is not ready");
    const response = await fetch(`${info.baseUrl}/workspace/${workspace}/opencode/session/${sessionId}/message`, {
      method: "POST", headers: { authorization: "Bearer " + String(info.ownerToken ?? info.clientToken), "content-type": "application/json" },
      body: JSON.stringify({ noReply: true, parts: [{ type: "text", text }] }),
    });
    if (!response.ok) throw new Error(`Creating retained history: HTTP ${response.status}`);
  }, [app.workspaceId, session.id, note]), { awaitPromise: true });
  await enableOrganizationCapabilities(seed, den.admin, { engineV2Upgrade: true });
  const origin = String(await evalIn(app, () => location.origin));
  const port = app.handle.meta?.vitePort;
  if (!port) throw new Error("The isolated renderer did not report its port");
  // A process-group signal can discard pending browser-storage writes; an
  // ordinary quit flushes the signed-in profile before the next launch.
  await quitDesktop(app);
  await app.stop();
  const restarted = await desktop({ name: "engine-upgrade-delayed-host", profileDir, prepareSharedResources: false,
    env: { PORT: port, OPENWORK_ELECTRON_START_URL: origin, OPENWORK_ENGINE_V2_PREVIEW: "0", OPENWORK_EVAL_LOCAL_SERVER_DELAY_MS: "5000" },
  });
  return {
    app: restarted, note,
    authStatus: () => control(restarted, "auth.status", {}),
    async status() {
      return evalIn(restarted, async () => {
        const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
        if (!info?.baseUrl) throw new Error("Local host is not ready");
        const response = await fetch(info.baseUrl + "/experimental/engine-v2-preview/status", { headers: { authorization: "Bearer " + String(info.ownerToken ?? info.clientToken) } });
        if (!response.ok) throw new Error(`Reading engine state: HTTP ${response.status}`);
        const value: unknown = await response.json();
        if (!value || typeof value !== "object") throw new Error("Invalid engine state");
        return { chatRouting: Reflect.get(value, "chatRouting"), v1HistoryAvailable: Reflect.get(value, "v1HistoryAvailable"), migration: Reflect.get(value, "migration") };
      }, { awaitPromise: true });
    },
    async [Symbol.asyncDispose]() { await restarted.stop(); },
  };
}
