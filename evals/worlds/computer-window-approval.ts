import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";

/** The production ComputerPanel, with only its native-helper responses arranged. */
export async function computerWindowApproval(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const decisions: unknown[] = [];
  try {
    const vite = await createServer({
      root: fileURLToPath(new URL("../../apps/app", import.meta.url)),
      configFile: fileURLToPath(new URL("../../apps/app/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "computer-window-approval-fixture", configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (url.pathname === "/fixture/decision" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            decisions.push(JSON.parse(body));
            res.setHeader("content-type", "application/json"); res.end("{}"); return;
          }
          if (url.pathname !== "/") return next();
          const html = await server.transformIndexHtml("/", '<!doctype html><html><head><title>Computer window approval</title></head><body><script type="module" src="/test-fixtures/computer-window-approval.tsx"></script></body></html>');
          res.setHeader("content-type", "text/html"); res.end(html);
        });
      } }],
    });
    resources.defer(() => vite.close());
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("The approval fixture did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "computer-window-approval", startUrl: url, headless: true }));
    return { web, url, decisions: () => structuredClone(decisions), async [Symbol.asyncDispose]() { await resources.disposeAsync(); } };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
