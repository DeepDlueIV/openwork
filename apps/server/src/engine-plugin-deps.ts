import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import constants from "../../../constants.json" with { type: "json" };
import { packagedResourcesPath } from "./openwork-extensions-plugin-path.js";
import { opencodeGlobalConfigDir, opencodePluginDepsArchive, seedOpencodePluginDeps } from "./selfhost-web.js";

/**
 * The pre-resolved OpenCode plugin install this build ships: in the desktop
 * app's resources, or in apps/server/dist when a checkout built it with
 * scripts/build-opencode-plugin-deps.mjs.
 */
export function bundledOpencodePluginDepsArchive(here: string = dirname(fileURLToPath(import.meta.url))): string {
  const resources = packagedResourcesPath(here);
  return opencodePluginDepsArchive(resources ? join(resources, "server") : join(here, ".."), constants.opencodeVersion);
}

/**
 * Give each OpenCode config folder the engine will read the pre-resolved
 * plugin install before the engine loads a folder: its global folder,
 * OPENCODE_CONFIG_DIR, and the `.opencode` folder of each local workspace.
 * Otherwise the engine answers nothing for a workspace until npm has installed
 * `@opencode-ai/plugin` into every one of them. Never throws.
 */
export async function seedEnginePluginDeps(input: {
  env: NodeJS.ProcessEnv;
  workspacePaths: readonly string[];
  archive?: string;
}): Promise<{ seeded: number; durationMs: number; failures: string[] }> {
  const archive = input.archive ?? bundledOpencodePluginDepsArchive();
  const configDirs = new Set([
    opencodeGlobalConfigDir(input.env),
    ...(input.env.OPENCODE_CONFIG_DIR?.trim() ? [input.env.OPENCODE_CONFIG_DIR.trim()] : []),
    ...input.workspacePaths.filter((path) => path.trim()).map((path) => join(path, ".opencode")),
  ]);
  const startedAt = Date.now();
  const results = await Promise.all([...configDirs].map((configDir) => seedOpencodePluginDeps({ archive, configDir })));
  return {
    seeded: results.filter((result) => result.seeded).length,
    durationMs: Date.now() - startedAt,
    failures: results.flatMap((result) => !result.seeded && result.reason === "failed" ? [result.error ?? "unknown error"] : []),
  };
}
