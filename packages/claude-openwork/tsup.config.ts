import { defineConfig } from "tsup"

// One self-contained executable: the shared agent-gateway-core source is
// imported by relative path and bundled in, so the package has no runtime
// dependencies.
export default defineConfig({
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  dts: false,
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
})
