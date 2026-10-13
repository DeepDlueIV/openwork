import { attachSurface } from "@openwork/cdp";
import { trackResource } from "@openwork/world";
import { cdpRelay } from "./freestyle-evidence.ts";

/**
 * The web evidence world on a Daytona Linux VM: the same world as Freestyle's,
 * built by @openwork/daytona-evidence. The runner only drives its browser.
 * Checkpoints are not offered yet; tests tagged `checkpoints` run without them.
 */
export async function daytonaEvidenceWeb(sourceSha: string) {
  // Loaded on demand so worlds that never pick Daytona do not load its client.
  const { ensureEvidenceTemplate } = await import("@openwork/daytona-evidence/builder");
  const { DaytonaApi } = await import("@openwork/daytona-evidence/api");
  const { launchDaytonaEvidenceWorld, deleteDaytonaEvidenceWorld, evidenceControl } = await import("@openwork/daytona-evidence");
  const api = new DaytonaApi();
  const template = await ensureEvidenceTemplate(sourceSha, api);
  const session = await launchDaytonaEvidenceWorld(template, sourceSha, api);
  try {
    await trackResource({ kind: "daytona-evidence", id: session.id, match: session.id, label: "evidence-web" });
    const relay = await cdpRelay(new URL(session.cdp.url), { cookie: session.cookie, "x-daytona-preview-token": session.cdp.previewToken, "x-daytona-skip-preview-warning": "true" });
    let app;
    try { app = await attachSurface({ name: "evidence-web", kind: "chrome", hostKind: "daytona", cdpUrl: relay.url, sandboxId: session.id }); }
    catch (error) { await relay[Symbol.asyncDispose](); throw error; }
    const close = app.stop.bind(app);
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      try { await close(); await relay[Symbol.asyncDispose](); } finally { await deleteDaytonaEvidenceWorld(session.id, api); }
    };
    app.stop = stop;
    app[Symbol.asyncDispose] = stop;
    return { app, session,
      continueStream: async () => { await evidenceControl(session.id, "continue", api); },
      async streamState() {
        const value: unknown = JSON.parse(await evidenceControl(session.id, "state", api));
        if (typeof value !== "object" || value === null || !("held" in value) || typeof value.held !== "boolean"
          || !("complete" in value) || typeof value.complete !== "boolean" || !("streamCount" in value) || typeof value.streamCount !== "number") throw new Error("Invalid stream witness");
        return { held: value.held, complete: value.complete, streamCount: value.streamCount };
      },
      stop, [Symbol.asyncDispose]: stop,
    };
  } catch (error) { await deleteDaytonaEvidenceWorld(session.id, api); throw error; }
}
