import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { stableNodePath } from "../../agent-gateway-core/src/index.ts"
import { main, type RunCommand, type RunResult } from "./main.ts"

const COMMAND_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 64 * 1024

/** Runs a program without a shell (Windows needs one for `claude.cmd`; the arguments here are fixed or validated URLs). */
const runCommand: RunCommand = (command, args) =>
  new Promise<RunResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    })
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk
    })
    child.on("error", (error) => {
      const notFound = "code" in error && error.code === "ENOENT"
      finish({ code: null, stdout, stderr, notFound })
    })
    child.on("close", (code) => {
      // Through a Windows shell, a missing program exits 9009 (cmd) instead of failing to spawn.
      finish({ code, stdout, stderr, notFound: process.platform === "win32" && code === 9009 })
    })
  })

const code = await main(process.argv.slice(2), {
  fetch: globalThis.fetch,
  runCommand,
  env: process.env,
  home: homedir(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  now: Date.now,
  nodePath: stableNodePath(process.execPath, process.env.PATH),
  platform: process.platform,
})
process.exitCode = code
