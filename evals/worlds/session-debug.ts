import type { Seed } from "@openwork/env";
import { browserScript } from "@openwork/cdp";

export async function sessionDebug(seed: Seed) {
  const workspacePath = seed.tmpPath("session-debug");
  const app = await seed.appWeb({ name: "session-debug", workspacePath, engine: "v2", mouse: true, headless: true });
  const workspace = await seed.workspace(app, workspacePath);
  const session = await seed.session(app, { title: "Debug a conversation" });
  // Read the browser's platform, which can differ from the runner's on remote
  // surfaces. This only selects the native shortcut; it does not change app state.
  const paletteShortcut = await seed.evalIn(app, browserScript(() =>
    /Mac/i.test(navigator.platform) ? "Meta+K" : "Control+K", []));
  return { app, workspace, session, paletteShortcut };
}
