import { realpathSync } from "node:fs"
import { delimiter, join } from "node:path"

function realpath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * The Node binary to store in a client's config. `process.execPath` is often a
 * versioned path (for example Homebrew's Cellar) that disappears on upgrade.
 * Prefer the `node` on PATH when it is the same binary, so the stored path
 * survives upgrades; otherwise keep the exact binary that is running.
 */
export function stableNodePath(
  execPath: string,
  pathEnv: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const target = realpath(execPath)
  if (!target || !pathEnv) return execPath
  const name = platform === "win32" ? "node.exe" : "node"
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir.startsWith("/") && platform !== "win32") continue
    const candidate = join(dir, name)
    if (candidate !== execPath && realpath(candidate) === target) return candidate
  }
  return execPath
}
