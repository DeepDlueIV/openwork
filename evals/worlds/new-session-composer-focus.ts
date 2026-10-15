import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

/** A workspace with a mock model that answers a first message and a short follow-up. */
export async function newSessionComposerFocus(seed: Seed) {
  const prompt = "Plan the next task";
  const reply = "The next task is ready.";
  // Typed key by key with no click first, so keep it short and space-free.
  const followup = "again";
  const followupReply = "The task has been checked again.";
  const workspacePath = seed.tmpPath("new-session-composer-focus");
  const app = await seed.appWeb({
    name: "new-session-composer-focus", workspacePath,
    mocks: { agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
      { promptMarker: prompt, latestUserTurn: true, finalReply: reply, steps: [] },
      { promptMarker: followup, latestUserTurn: true, finalReply: followupReply, steps: [] },
    ] }) },
  });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("Missing composer focus model witness");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "focus-mock", "focus-model", {
    provider: { "focus-mock": {
      npm: "@ai-sdk/openai-compatible", name: "Composer focus mock",
      options: { baseURL: `${mock.url}/v1`, apiKey: "sk-composer-focus-fixture" },
      models: { "focus-model": { name: "Composer focus model" } },
    } },
  });
  return {
    app, workspace, prompt, reply, followup, followupReply,
    // appWeb uses history routing rather than the desktop hash router.
    route: () => seed.evalIn(app, () => location.pathname),
  };
}
