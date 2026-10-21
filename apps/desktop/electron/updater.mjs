import { createRequire } from "node:module";
import { registerUpdaterIpc as registerUpstreamUpdaterIpc } from "./updater-upstream.mjs";
import { registerNoClipUpdaterIpc } from "./noclip-updater.mjs";
export * from "./updater-upstream.mjs";

const require = createRequire(import.meta.url);
const metadata = require("../package.json");

export function registerUpdaterIpc(options) {
  // The packaged identity is authoritative; environment flags cannot re-enable
  // upstream updates, recovery downloads or an already-staged install on quit.
  if (metadata.openworkDistribution === "noclip") return registerNoClipUpdaterIpc(options);
  return registerUpstreamUpdaterIpc(options);
}
