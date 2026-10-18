import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { buildWorkbotTurns } from "../../ee/packages/workbot-server/src/thread.ts";
import type { RunnerSnapshot } from "../../ee/packages/headless-protocol/src/client.ts";

/** The shipped Workbot app and transcript adapter, with deterministic runner/file responses and a transport fault. */
export async function workbotActivity(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const at = Date.now() - 5000;
  let unavailable = false;
  let stopAttempts = 0;
  let taskStopAttempts = 0;
  let sends = 0;
  let progressStage = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  resources.defer(() => { for (const timer of timers) clearTimeout(timer); });
  const streams = new Set<ServerResponse>();
  const snapshot: RunnerSnapshot = {
    turns: [{ messageId: "wb_example", status: "running", error: null, createdAt: at, updatedAt: at + 3000 }, { messageId: "wb_background", kind: "task", parent: "wb_example", title: "Review charts", status: "running", error: null, createdAt: at, updatedAt: at + 3000 }],
    messages: [
      { role: "user", messageId: "wb_example", text: "Prepare the report", createdAt: at },
      { role: "assistant", messageId: "wb_example", text: "The report has three sections.", createdAt: at + 100, toolCalls: [
        { id: "skill", name: "execute_capability", input: { name: "skill:slack-calendar-report" } },
        { id: "command", name: "bash", input: { description: "Checking the report" } },
      ] },
      { role: "tool", messageId: "wb_example", name: "bash", callId: "command", isError: true, createdAt: at + 3000 },
    ], finalAssistantText: "", status: "busy",
  };
  const changed = () => { for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: "changed", messageId: "example" })}\n\n`); };
  try {
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "workbot-activity-fixture", configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (!url.pathname.startsWith("/v1/workbot")) return next();
          const json = (body: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
          if (url.pathname === "/v1/workbot/me") return json({ name: "Alex", email: "alex@example.test", userId: "user_example", organizationId: "org_example", organizationName: "Example", enabled: true, calendar: false, documents: false, workspaceAssistant: false, sideChats: false, denUrl: "https://example.test" });
          if (url.pathname === "/v1/workbot/events") {
            if (unavailable) return json({ error: "unavailable" }, 503);
            res.statusCode = 200; res.setHeader("content-type", "text/event-stream"); res.write("event: ready\ndata: {}\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return;
          }
          if (url.pathname === "/v1/workbot") {
            if (unavailable) return json({ error: "unavailable" }, 503);
            const turns = buildWorkbotTurns(snapshot);
            return json({ available: true, name: "Workbot", organizationName: "Example", status: snapshot.status, turns, hasEarlier: false, filesEnabled: false });
          }
          if (url.pathname === "/v1/workbot/stop" && req.method === "POST") {
            stopAttempts += 1;
            if (stopAttempts === 1) return json({ error: "runner_unavailable" }, 503);
            if (snapshot.turns[0]) { snapshot.turns[0].status = "aborted"; snapshot.turns[0].updatedAt = Date.now(); }
            snapshot.status = "idle"; changed(); return json({ stopped: true });
          }
          if (url.pathname === "/v1/workbot/tasks/background/stop" && req.method === "POST") {
            taskStopAttempts += 1;
            if (taskStopAttempts === 1) return json({ error: "runner_unavailable" }, 503);
            if (snapshot.turns[1]) { snapshot.turns[1].status = "aborted"; snapshot.turns[1].updatedAt = Date.now(); }
            changed(); return json({ stopped: true });
          }
          if (url.pathname === "/v1/workbot/messages" && req.method === "POST") {
            sends += 1;
            let body = ""; for await (const chunk of req) body += chunk;
            const input: unknown = JSON.parse(body);
            if (typeof input !== "object" || input === null || !("id" in input) || typeof input.id !== "string") return json({ error: "invalid_request" }, 400);
            const messageId = `wb_${input.id}`;
            const turn = { messageId, status: "running", error: null, createdAt: Date.now(), updatedAt: Date.now() };
            snapshot.turns.push(turn); snapshot.status = "busy";
            snapshot.messages.push({ role: "user", messageId, text: "Check progress" });
            const command = (index: number) => { progressStage = index * 2 - 1; snapshot.messages.push({ role: "assistant", messageId, text: "", createdAt: Date.now(), toolCalls: [{ id: `progress-${index}`, name: "bash", input: { description: `Checking section ${index}` } }] }); changed(); };
            const result = (index: number) => { progressStage = index * 2; snapshot.messages.push({ role: "tool", messageId, name: "bash", callId: `progress-${index}`, isError: index === 3, createdAt: Date.now() }); changed(); };
            command(1);
            for (const [delay, act] of [[600, () => result(1)], [1200, () => command(2)], [1800, () => result(2)], [2400, () => command(3)], [3000, () => result(3)]] satisfies Array<[number, () => void]>) timers.add(setTimeout(act, delay));
            timers.add(setTimeout(() => { turn.status = "completed"; turn.updatedAt = Date.now(); snapshot.status = "idle"; snapshot.messages.push({ role: "assistant", messageId, text: "I couldn't verify every section.", toolCalls: [] }); changed(); }, 3800));
            return json({ accepted: true }, 202);
          }
          return json({ error: "not_found" }, 404);
        });
      } }],
    });
    resources.defer(async () => { for (const stream of streams) stream.end(); await vite.close(); });
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Workbot proof did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-activity", startUrl: url, headless: true }));
    return {
      web, url,
      stopAttempts: () => stopAttempts, taskStopAttempts: () => taskStopAttempts, sends: () => sends, progressStage: () => progressStage,
      disconnect() { unavailable = true; for (const stream of streams) stream.end(); streams.clear(); },
      restore() { unavailable = false; },

      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
