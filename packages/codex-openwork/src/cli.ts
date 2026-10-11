import { homedir } from "node:os"
import { stableNodePath } from "../../agent-gateway-core/src/index.ts"
import { defaultRunCommand } from "./codex.ts"
import { main } from "./main.ts"

const controller = new AbortController()
process.once("SIGINT", () => {
  controller.abort()
  process.exitCode = 130
})

const code = await main(process.argv.slice(2), {
  fetch: (input, init) => globalThis.fetch(input, init),
  run: defaultRunCommand,
  env: process.env,
  home: homedir(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  now: Date.now,
  nodePath: stableNodePath(process.execPath, process.env.PATH),
  platform: process.platform,
  signal: controller.signal,
})
if (process.exitCode === undefined) process.exitCode = code
