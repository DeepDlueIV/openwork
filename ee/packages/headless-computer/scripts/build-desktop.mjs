import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/desktop-guest.mjs"], outfile: "dist/desktop-guest.mjs", bundle: true,
  platform: "node", format: "esm", target: "node22",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
await copyFile(new URL("../../../apps/den-worker-runtime/scripts/cloud-desktop.sh", import.meta.url), new URL("../dist/cloud-desktop.sh", import.meta.url));
