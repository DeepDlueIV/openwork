/** Exercise the production desktop bridge on a dedicated, already-created CLI-authenticated Daytona VM. */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { gzipSync } from "node:zlib"
import assert from "node:assert/strict"
import { createFakeProvider } from "@openwork/sandbox/testing"
import { shellQuote } from "@openwork/sandbox"
import { WebSocket } from "ws"
import { Desktop } from "../src/desktop.js"

const sandbox = process.argv[2]
if (!sandbox) throw new Error("Pass a dedicated Daytona sandbox name; this check operates its desktop.")
const execute = promisify(execFile)
async function cli(args: string[]) {
  try { return (await execute("daytona", args, { maxBuffer: 8 * 1024 * 1024, timeout: 150_000 })).stdout }
  catch { throw new Error("Daytona proof command failed; inspect the owned sandbox.") }
}
const remote = (command: string) => cli(["exec", sandbox, "--", command])
const fake = createFakeProvider()
const provider = {
  ...fake,
  describe: () => ({ ...fake.describe(), platform: { os: "linux" as const, isolation: "vm" as const } }),
  blocks: {
    ...fake.blocks,
    run: async (_box: unknown, input: { command: string }) => ({ exitCode: 0, stdout: await remote(input.command), stderr: "" }),
    files: {
      ...fake.blocks!.files!,
      write: async (_box: unknown, path: string, bytes: Uint8Array) => {
        await remote(`printf %s ${shellQuote(gzipSync(bytes).toString("base64"))} | base64 -d | gzip -d > ${shellQuote(path)}`)
      },
    },
  },
  endpoint: async () => {
    const output = await cli(["preview-url", sandbox, "--port", "6080", "--expires", "75"])
    const url = output.match(/https:\/\/\S+/)?.[0]
    if (!url) throw new Error("Daytona returned no signed viewer URL.")
    return { url, expiresAt: new Date(Date.now() + 75_000), kind: "signed-expiring" as const }
  },
}
const desktop = new Desktop(provider)
const box = await fake.create({ idempotencyKey: "desktop-proof", image: null, labels: {}, env: {}, storage: [], exposePorts: [] }, { timeoutMs: 1000 })
await desktop.start(box)
const browser = (operation: string, args: Record<string, unknown>) => desktop.call(box, "/browser/task", { sessionId: "vnc-proof", operation, args })
const opened = await browser("open", { url: "http://127.0.0.1:8765/page" })
assert.ok(typeof opened === "object" && opened !== null && "tabId" in opened)
const tabId = Reflect.get(opened, "tabId")

// First validate the exact RFB handshake over the signed, origin-bound WebSocket; never print its credentials.
for (const view of ["browser", "computer"] as const) {
  const ticket = await desktop.viewer(box, { view, control: false, origin: "http://localhost:3020" })
  const received = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(ticket.url, { origin: "http://localhost:3020" })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("VNC handshake timed out")) }, 15_000)
    ws.once("message", data => { clearTimeout(timer); ws.close(); resolve(data.toString()) })
    ws.once("error", () => { clearTimeout(timer); reject(new Error("VNC WebSocket failed")) })
  })
  assert.match(received, /^RFB 003\./)
  const replay = await new Promise<boolean>(resolve => {
    const ws = new WebSocket(ticket.url, { origin: "http://localhost:3020" })
    ws.once("open", () => { ws.close(); resolve(false) }); ws.once("error", () => resolve(true))
  })
  assert.equal(replay, true)
}
await browser("observe", { tabId })
console.log(JSON.stringify({ signedBrowserStream: true, signedDesktopStream: true, oneUseTickets: true, sharedBrowserTool: true }))
