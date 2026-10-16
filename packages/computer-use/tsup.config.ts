import { defineConfig } from "tsup"

export default defineConfig({
  entry: { runtime: "src/runtime.ts" },
  format: ["esm"],
  platform: "node",
  target: "es2022",
  clean: true,
  dts: false,
  // Keep the interpreter's matching Effect runtime inside the desktop artifact.
  external: ["typescript"],
  noExternal: ["@openwork/codemode", "effect", "acorn", "zod"],
})
