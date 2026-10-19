import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";

/** Real Workbot UI, deterministic identity/permission responses; API isolation has separate real-MySQL tests. */
export async function workbotTeamLinks(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  try {
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "workbot-team-links-fixture", configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (!url.pathname.startsWith("/v1/workbot")) return next();
          const page = new URL(req.headers.referer ?? "http://fixture");
          const admin = page.searchParams.get("persona") !== "member";
          const json = (body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
          if (url.pathname === "/v1/workbot/me") return json({ name: "Workspace Owner", email: "owner@example.test", userId: "user_example", organizationId: "org_linked", organizationName: "Team workspace", enabled: true, calendar: false, sideChats: false, denUrl: "https://den.example.test", teamLinks: { enabled: page.searchParams.get("links") === "on", settings: admin, apps: admin } });
          if (url.pathname === "/v1/workbot") return json({ available: true, name: "Workbot", organizationName: "Team workspace", status: "idle", turns: [{ id: "turn_example", text: "Help with my work", sentAt: 1792346400000, finishedAt: 1792346400000, status: "done", attachments: [], outputs: [], parts: [{ kind: "text", text: "What would you like to work on?" }], modelSteps: 1, error: null, greeting: false }], hasEarlier: false, filesEnabled: false });
          if (url.pathname === "/v1/workbot/events") { res.setHeader("content-type", "text/event-stream"); res.end(": fixture\n\n"); return; }
          res.statusCode = 404; json({ error: "not_found" });
        });
      } }],
    });
    resources.defer(() => vite.close());
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Workbot fixture did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-team-links", startUrl: url, headless: true }));
    return { web, url, async [Symbol.asyncDispose]() { await resources.disposeAsync(); } };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
