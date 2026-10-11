import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { isAbsolute, join, delimiter } from "node:path"
import { spawn } from "node:child_process"
import { verifyNativeMcp } from "./verify-native-mcp.mjs"

export async function findCodexBinary({ environment = process.env, executable } = {}) {
  const candidates = [executable, environment.CODEX_CLI_PATH,
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    ...(environment.PATH ?? "").split(delimiter).filter(Boolean).map(path => join(path, process.platform === "win32" ? "codex.exe" : "codex"))]
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue
    try { await access(candidate, constants.X_OK); return candidate } catch {}
  }
  return null
}

/** Official CLI only. No direct configuration writes, permission replies or debug flags. */
export function runCodexJson(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] })
    let output = "", bytes = 0, settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) { child.kill(); reject(error) } else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error("Codex plugin installation timed out; readiness was not verified.")), 30000)
    child.stdout.on("data", chunk => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) return finish(new Error("Codex plugin result exceeded the size limit."))
      output += chunk.toString("utf8")
    })
    // Native errors can contain account/configuration data; do not echo their bodies.
    child.stderr.resume()
    child.once("error", () => finish(new Error("Could not start the Codex plugin manager.")))
    child.once("close", code => {
      if (code !== 0) return finish(new Error("Codex plugin manager failed. Files are catalogued, but native installation was not verified."))
      try { finish(null, JSON.parse(output)) } catch { finish(new Error("Codex plugin manager returned an invalid result; readiness was not verified.")) }
    })
  })
}

export async function installIntoCodex({ executable, pluginName, marketplaceName, version, marketplacePath, run = runCodexJson, verify = verifyNativeMcp }) {
  const pluginId = `${pluginName}@${marketplaceName}`
  const result = await run(executable, ["plugin", "add", pluginId, "--json"])
  if (result?.pluginId !== pluginId || result?.name !== pluginName || result?.marketplaceName !== marketplaceName || result?.version !== version || typeof result?.installedPath !== "string") throw new Error("Codex did not confirm installation of the requested receiver version.")
  const listed = await run(executable, ["plugin", "list", "--marketplace", marketplaceName, "--json"])
  const installed = listed?.installed?.find(plugin => plugin.pluginId === pluginId)
  if (!installed || installed.installed !== true || installed.enabled !== true || installed.version !== version) throw new Error("The receiver is not installed and enabled in Codex. Review its native plugin status; permissions were not approved automatically.")
  const declaration = await verify({ executable, marketplacePath, marketplaceName, pluginName })
  if (declaration?.pluginId !== pluginId || !Array.isArray(declaration.mcpServers) || !declaration.mcpServers.includes(pluginName)) throw new Error("The native loader discarded the receiver MCP server. Installation is not ready.")
  return { pluginId, installed: true, enabled: true, mcpDeclared: declaration.mcpServers.includes(pluginName), installedPath: result.installedPath,
    pluginUrl: `codex://plugins/install/${encodeURIComponent(pluginName)}?marketplace=${encodeURIComponent(marketplaceName)}`,
    message: "Codex confirms the receiver is installed and enabled. Sign-in, project consent and native permissions remain yours to approve. Tools must still be loaded in a genuine Codex chat." }
}
