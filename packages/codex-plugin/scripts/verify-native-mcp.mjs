import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

/** Read-only native configuration inspection in an isolated CLI process. This
 * does not create sessions, invoke app tools or prove GUI-context readiness.
 */
export function inspectNativePlugin({ executable, marketplacePath, pluginName }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"] })
    const decoder = new StringDecoder("utf8")
    let buffer = "", bytes = 0, finished = false
    const finish = (error, result) => {
      if (finished) return
      finished = true; clearTimeout(timer)
      child.stdin.end(); child.kill()
      if (error) reject(error); else resolve(result)
    }
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`)
    const timer = setTimeout(() => finish(new Error("Native MCP declaration verification timed out; callable tools are not verified.")), 20000)
    child.stderr.resume()
    child.once("error", () => finish(new Error("Native MCP declaration inspection could not start.")))
    child.once("close", () => { if (!finished) finish(new Error("Native MCP declaration inspection ended without a result.")) })
    child.stdin.on("error", () => finish(new Error("Native MCP declaration inspection disconnected.")))
    child.stdout.on("data", chunk => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) return finish(new Error("Native MCP inspection exceeded its response limit."))
      buffer += decoder.write(chunk)
      while (!finished && buffer.includes("\n")) {
        const index = buffer.indexOf("\n")
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        let response
        try { response = JSON.parse(line) } catch { return finish(new Error("Native MCP inspection returned invalid JSON.")) }
        if (response.id === "openwork-load-init") {
          if (response.error) return finish(new Error("Native MCP inspection initialization was rejected."))
          send({ method: "initialized", params: {} })
          send({ id: "openwork-load-read", method: "plugin/read", params: { marketplacePath, pluginName } })
        } else if (response.id === "openwork-load-read") {
          const detail = response.result?.plugin
          if (response.error || !detail || !Array.isArray(detail.mcpServers)) return finish(new Error("Native loader did not return the receiver's MCP declarations."))
          finish(null, { pluginId: detail.summary?.id, mcpServers: detail.mcpServers })
        }
        // Ignore unrelated notifications; never print native data or stderr.
      }
    })
    send({ id: "openwork-load-init", method: "initialize", params: { clientInfo: { name: "openwork_receiver_loader_check", version: "1" }, capabilities: { experimentalApi: true } } })
  })
}

export async function verifyNativeMcp(options) {
  const result = await inspectNativePlugin(options)
  const expected = `${options.pluginName}@${options.marketplaceName}`
  if (result.pluginId !== expected || !result.mcpServers.includes(options.pluginName)) throw new Error("Codex installed the plugin but discarded its MCP declaration. Receiver tools are not loaded; do not report setup as ready.")
  return result
}
