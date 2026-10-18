import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";

/** Real Workbot UI with synthetic member responses. No invitations or provider calls are mocked as successes. */
export async function workbotSharing(seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const writes: string[] = [];
  try {
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "workbot-sharing-fixture", configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          // Real browser policy denial, not a replacement clipboard implementation.
          if (url.searchParams.get("clipboard") === "blocked") res.setHeader("Permissions-Policy", "clipboard-write=()");
          if (!url.pathname.startsWith("/v1/workbot")) return next();
          if (req.method !== "GET") writes.push(url.pathname);
          const page = new URL(req.headers.referer ?? "http://fixture");
          const json = (body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
          if (url.pathname === "/v1/workbot/me") return json({ name: "Team Member", email: "member@example.test", userId: "user_example", organizationId: "org_example", organizationName: "Sharing workspace", enabled: true, calendar: false, sideChats: false, denUrl: "https://den.example.test", shareWorkbot: { enabled: page.searchParams.get("sharing") === "on" } });
          if (url.pathname === "/v1/workbot") return json({ available: true, name: "Workbot", organizationName: "Sharing workspace", status: "idle", turns: [{ id: "turn_example", text: "Help with my work", sentAt: 1792346400000, finishedAt: 1792346400000, status: "done", attachments: [], outputs: [], parts: [{ kind: "text", text: "What would you like to work on?" }], modelSteps: 1, error: null, greeting: false }], hasEarlier: false, filesEnabled: false });
          if (url.pathname === "/v1/workbot/events") { res.setHeader("content-type", "text/event-stream"); res.end(": fixture\n\n"); return; }
          res.statusCode = 404; json({ error: "not_found" });
        });
      } }],
    });
    resources.defer(() => vite.close());
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Workbot fixture did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-sharing", startUrl: url, headless: true }));
    await web.client.send("Browser.grantPermissions", { origin: new URL(url).origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
    return { web, url, writes: () => [...writes],
      // TODO(primitive): probe.clipboard has no read-only witness yet. This reads only this fresh test browser's clipboard.
      readClipboard: () => seed.evalIn(web, () => navigator.clipboard.readText(), { awaitPromise: true }),
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); } };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
