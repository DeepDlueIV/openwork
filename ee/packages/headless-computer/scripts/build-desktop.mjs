import { build } from "esbuild";
import { copyFile } from "node:fs/promises";

await build({
  entryPoints: ["src/desktop-guest.mjs"], outfile: "dist/desktop-guest.mjs", bundle: true,
  platform: "node", format: "esm", target: "node22",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
await copyFile("../../apps/den-worker-runtime/scripts/cloud-desktop.sh", "dist/cloud-desktop.sh");
