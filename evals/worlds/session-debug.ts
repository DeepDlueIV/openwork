import type { Seed } from "@openwork/env";

export async function sessionDebug(seed: Seed) {
  const workspacePath = seed.tmpPath("session-debug");
  const app = await seed.appWeb({ name: "session-debug", workspacePath, engine: "v2", mouse: true, headless: true });
  const workspace = await seed.workspace(app, workspacePath);
  const session = await seed.session(app, { title: "Debug a conversation" });
  return { app, workspace, session };
}
