import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer, loadConfigFromFile, type Plugin, type PluginOption } from "vite";
import { chrome, createLocalHost } from "@openwork/hosts";
import type { Seed } from "@openwork/env";

function cssPlugins(options: PluginOption[]): Plugin[] {
  return options.flatMap(option => Array.isArray(option) ? cssPlugins(option)
    : option && "name" in option && option.name.startsWith("@tailwindcss/") ? [option] : []);
}

/** The real transcript and styles, with the staged checklist feature enabled. */
export async function appProgressSpacing(_seed: Seed) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const appRoot = resolve(root, "apps/app");
  const fixture = resolve(root, "evals/worlds/fixtures/app-progress-spacing.tsx");
  const config = await loadConfigFromFile({ command: "serve", mode: "test" }, resolve(appRoot, "vite.config.ts"));
  if (!config) throw new Error("App Vite configuration missing");
  await using resources = new AsyncDisposableStack();
  const vite = await createServer({
    configFile: false, root: appRoot,
    resolve: { alias: { "@": resolve(appRoot, "src") }, dedupe: ["react", "react-dom"] },
    esbuild: { jsx: "automatic" },
    cacheDir: resolve(root, "evals/results/app-progress-spacing/vite"),
    optimizeDeps: { entries: [fixture] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, fs: { allow: [root] } },
    plugins: [...cssPlugins(config.config.plugins ?? []), {
      name: "app-progress-spacing-fixture", enforce: "pre",
      resolveId(source: string) {
        if (source.replace(resolve(appRoot, "src"), "@") === "@/react-app/domains/apps/use-app-build-progress-feature") return "\0spacing-feature";
      },
      load(id: string) {
        if (id === "\0spacing-feature") return "export function useAppBuildProgressEnabled() { return true; }";
      },
      configureServer(server: import("vite").ViteDevServer) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/") return next();
          response.setHeader("Content-Type", "text/html");
          void server.transformIndexHtml("/", `<!doctype html><title>App progress spacing</title><div id="root"></div><script type="module" src="/@fs/${fixture}"></script>`)
            .then(html => response.end(html)).catch(next);
        });
      },
    }],
  });
  resources.defer(() => vite.close());
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Spacing fixture port missing");
  // This component fixture and its browser must share the same loopback host.
  const host = resources.use(createLocalHost({ repoRoot: root, log: () => {} }));
  const app = resources.use(await chrome({ name: "app-progress-spacing", host, startUrl: "about:blank", headless: true }));
  const retained = resources.move();
  return { app, url: `http://127.0.0.1:${address.port}/`, async [Symbol.asyncDispose]() { await retained.disposeAsync(); } };
}
