#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import { realpathSync } from "node:fs"
import { login, enable, disable, logout, status, nativeFactory } from "./setup.mjs"
import { readConfig } from "./state.mjs"
import { startRunnerHost } from "./runner-host.mjs"

export async function main(args = process.argv.slice(2)) {
  const command = args.shift() ?? "help"
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === "--confirm") options.confirm = true
    else if (["--directory", "--api", "--org", "--source-thread", "--label"].includes(flag) && args[i + 1]) {
      const key = { "--directory": "directory", "--api": "apiBaseUrl", "--org": "orgId", "--source-thread": "sourceThreadId", "--label": "label" }[flag]
      options[key] = args[++i]
    } else throw new Error("Unknown option. Use help; never pass credentials on the command line.")
  }
  const print = value => console.log(JSON.stringify(value, null, 2))
  if (command === "login") {
    print(await login({ ...options, onAuthorization: details => console.log(`Open ${details.verificationUriComplete}\nApprove code ${details.userCode}. This does not enable remote control.`) }))
  } else if (command === "enable") print(await enable(options))
  else if (command === "disable") print(await disable())
  else if (command === "logout") print(await logout())
  else if (command === "status") print(await status())
  else if (command === "doctor") {
    const config = await readConfig()
    const adapter = await nativeFactory({ ...config, ...options })
    try { print(await adapter.diagnose(AbortSignal.timeout(10_000))) } finally { await adapter.close?.() }
  } else if (command === "run") {
    const controller = new AbortController()
    const host = await startRunnerHost({ adapterFactory: nativeFactory, onStatus: value => console.error(JSON.stringify(value)) })
    if (!host.owned) { print(host.status()); return }
    console.error("OpenWork Codex runner is active. Ctrl-C stops remote control, not Codex's native chats.")
    const stop = () => controller.abort()
    process.once("SIGINT", stop); process.once("SIGTERM", stop)
    if (!controller.signal.aborted) await new Promise(resolve => controller.signal.addEventListener("abort", resolve, { once: true }))
    await host.close()
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop)
  } else if (command === "install") {
    const { installPlugin } = await import("../scripts/install.mjs")
    print(await installPlugin())
  } else if (command === "help") {
    console.log(`OpenWork Codex local prototype\n\n  login [--api URL] [--org ID]\n  doctor [--directory FOLDER] [--source-thread THREAD_ID]\n  enable --directory FOLDER --confirm [--source-thread THREAD_ID] [--label NAME]\n  run\n  status\n  disable\n  logout\n  install\n\nCURRENT LIMIT: new GUI-chat creation is unverified; remote enrollment fails closed.\nLogin and the read-only doctor are usable. Existing Codex approvals stay in the GUI.\nOnce creation is verified: use remote-session:targets and its exact Codex computerId.`)
  } else throw new Error("Unknown command. Use help.")
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
