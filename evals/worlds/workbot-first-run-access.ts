import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { allocateFreePorts } from "@openwork/cdp";

/** Real standalone client, synthetic signed-in session answers. API tests separately prove the permission calculation. */
export async function workbotFirstRunAccess(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  try {
    const [port] = await allocateFreePorts(1);
    if (!port) throw new Error("No local port available");
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port, strictPort: true },
      plugins: [{ name: "workbot-access-fixture", configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (!url.pathname.startsWith("/v1/workbot")) return next();
          const params = new URL(req.headers.referer ?? "http://fixture").searchParams;
          const enabled = params.get("enabled") === "true";
          const json = (body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
          if (url.pathname === "/v1/workbot/me") return json({ name: "Example", email: "member@example.test", userId: "user_example", organizationId: "org_example", organizationName: "Example workspace", enabled, firstRun: params.get("rollout") !== "off", canEnableWorkbot: params.get("admin") === "true", denUrl: "https://workspace.example.test" });
          if (url.pathname === "/v1/workbot") return json(enabled ? { available: true, name: "Workbot", organizationName: "Example workspace", status: "idle", turns: [], hasEarlier: false, filesEnabled: false } : { available: false, reason: "workbot_not_enabled" });
          if (url.pathname.endsWith("/events")) { res.setHeader("content-type", "text/event-stream"); res.end(": fixture\n\n"); return; }
          if (url.pathname.endsWith("/connections")) return json({ connections: [] });
          if (url.pathname.endsWith("/hello")) return json({ started: false });
          return json({});
        });
      } }],
    });
    resources.defer(() => vite.close());
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Workbot access fixture did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-first-run-access", startUrl: `${url}?rollout=off`, headless: true }));
    return { web, url, async [Symbol.asyncDispose]() { await resources.disposeAsync(); } };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
