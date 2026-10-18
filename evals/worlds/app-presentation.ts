import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { evaluate } from "@openwork/cdp";
import { z } from "zod";
import type { Seed } from "@openwork/env";
import { mcpAppResourceUri } from "@openwork/types/mcp-app";
import { buildGeneratedMcpApp } from "../../ee/apps/den-api/src/generated-artifact-view-builder.ts";
import { configureProvider } from "./chat.ts";
import { appPresentationHttp } from "./app-presentation-http.ts";

export const APP_REQUEST = "Make a project checklist I can open later.";
export const APP_REPLY = "The project checklist is published. Open it to review and mark completed items.";
export const APP_FALLBACK = "Review the project checklist and mark completed items.";
const appId = "cob_00000000000000000000000000";
const revisionId = "cov_00000000000000000000000000";
export const APP_RESOURCE = mcpAppResourceUri(appId, revisionId);
type Scenario = "cold" | "warm" | "slow" | "error" | "reopen";

/** Real appWeb, engine, message capture and generated React runtime. Only the
 * published resource discovery has deterministic network slowness/errors. */
export async function appPresentation(seed: Seed) {
  const healthy = await buildGeneratedMcpApp({ title: "Project checklist", description: null,
    reactSource: `export default function Checklist() {
      const [done, setDone] = React.useState(false);
      return <main><h2>Project checklist</h2><p>{done ? "Review completed" : "Review pending"}</p><button type="button" onClick={() => setDone(true)}>Mark reviewed</button></main>;
    }`, cssSource: "body{margin:0}main{padding:16px}h2{font-size:16px}button{font:inherit}" });
  const broken = await buildGeneratedMcpApp({ title: "Project checklist", description: null,
    reactSource: `export default function Checklist() { throw new Error("The checklist could not render."); }` });
  if (!healthy.ok || !broken.ok) throw new Error("The representative generated App did not compile");
  const summary = { appId, revisionId, resourceUri: APP_RESOURCE, title: "Project checklist", description: null,
    pluginId: "plg_00000000000000000000000000", toolName: "open_app", serverPath: `/mcp/agent/connections/${appId}`,
    textFallback: APP_FALLBACK, tools: [] };
  const launch = { connectionId: appId, toolName: "open_app", resourceUri: APP_RESOURCE, arguments: {} };
  const mock = seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true,
    tools: [{ name: "create_app", description: "Publish the requested project checklist", inputSchema: { type: "object", properties: {} },
      result: { content: [{ type: "text", text: "The project checklist is published." }],
        structuredContent: { app: summary, launch, input: {} }, _meta: { "openwork/mcpApp": launch } } }],
    agentWorkloads: [{ promptMarker: APP_REQUEST, latestUserTurn: true, finalReply: APP_REPLY,
      finalReplyChunks: [APP_REPLY], finalReplyInitiallyReleasedChunks: 0,
      steps: [{ tool: "create_app", arguments: {} }] }],
  });
  const app = await seed.appWeb({ name: "app-presentation", workspacePath: seed.tmpPath("app-presentation"), engine: "v1", headless: true, mocks: { agent: mock } });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("The publication witness did not start");
  const workspace = await seed.workspace(app, app.workspaceRoot);
  await configureProvider(seed, app, workspace.workspaceId, "presentation", "checklist", {
    permission: { "*": "allow" },
    mcp: { openwork: { type: "remote", url: witness.mcpUrl, enabled: true, oauth: false } },
    provider: { presentation: { npm: "@ai-sdk/openai-compatible", name: "Project model",
      options: { baseURL: `${witness.url}/v1`, apiKey: "synthetic-presentation-key" }, models: { checklist: { name: "Project model" } } } },
  }, "v1");
  const session = await seed.session(app, { title: "Project checklist" });
  let scenario: Scenario = "cold";
  const resolutions: { scenario: Scenario; elapsedMs: number }[] = [];
  let count = 0;
  const network = await appPresentationHttp(app, async () => {
    const current = scenario;
    const start = performance.now();
    if (current === "slow") await wait(1_800);
    else if (current === "cold") await wait(250);
    resolutions.push({ scenario: current, elapsedMs: Math.round(performance.now() - start) });
    return { app: { launchId: `presentation-${++count}`, serverName: "openwork-app-host-connect-fixture", toolName: "open_app",
      resourceUri: APP_RESOURCE, html: current === "error" ? broken.html : healthy.html, csp: healthy.csp, prefersBorder: false } };
  });
  if (!app.client.webSocketDebuggerUrl) throw new Error("The App's browser has no CDP endpoint");
  const endpoint = new URL(app.client.webSocketDebuggerUrl);
  const flicker = fileURLToPath(new URL("../../.opencode/skills/measure-chat-flicker/scripts/flicker.mjs", import.meta.url));
  const runFlicker = (command: "arm" | "report") => execFileSync(process.execPath, [flicker, command], {
    env: { ...process.env, CDP_URL: `http://${endpoint.host}` }, encoding: "utf8", timeout: 20_000,
  }).trim();
  return {
    app, session, workspace,
    scenario(next: Scenario) { network.check(); scenario = next; },
    resolutions() { network.check(); return [...resolutions]; },
    published: () => witness.toolCalls(),
    releaseReply: () => witness.releaseAgentReply(APP_REQUEST, 1),
    armFlicker: () => runFlicker("arm"),
    flicker: () => z.object({ upwardJumps: z.number(), downwardMoves: z.number(), samples: z.string() }).parse(JSON.parse(runFlicker("report"))),
    // Read-only observations: actual layout, focus and bounded diagnostic timing.
    geometry: () => evaluate(app.client, () => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const r = element.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      };
      return { fallback: rect("[data-mcp-app-fallback]"), panel: rect("[data-built-app-preview]"),
        composer: rect('[data-lexical-editor="true"]'), loading: rect("[data-loading-message]"),
        focus: document.activeElement?.getAttribute("aria-label"),
        timings: performance.getEntriesByType("measure").filter(entry => entry.name.startsWith("openwork.mcp-app.")).map(entry => ({ name: entry.name, duration: Math.round(entry.duration) })) };
    }),
    async [Symbol.asyncDispose]() { await network[Symbol.asyncDispose](); },
  };
}
