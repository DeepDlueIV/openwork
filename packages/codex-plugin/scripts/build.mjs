import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

// Reuse the workspace's installed builder. The installed prototype has no dependencies.
const require = createRequire(new URL("../../opencode-plugin/package.json", import.meta.url))
const { build } = await import(require.resolve("tsup"))
await build({
  entry: [fileURLToPath(new URL("../../remote-sessions/src/index.ts", import.meta.url))],
  format: ["esm"],
  outDir: fileURLToPath(new URL("../lib", import.meta.url)),
  outExtension: () => ({ js: ".mjs" }),
  config: false,
  clean: true,
  sourcemap: false,
  target: "node22",
})
