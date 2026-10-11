import { defineConfig } from "tsup"

// One self-contained executable: the shared agent-gateway-core source is
// bundled in, and the package has no runtime dependencies.
export default defineConfig({
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  dts: false,
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  noExternal: [/.*/],
  platform: "node",
  splitting: false,
  target: "node20",
})
