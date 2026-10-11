#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { createNativeCodexAdapter } from "../src/native-codex.mjs"

/** Read-only, no auth/enrollment writes, no transcripts, no mutations, no runner. */
export async function diagnose(args = process.argv.slice(2)) {
  const options = { directory: process.cwd(), workspaceId: "codex-local" }
  for (let index = 0; index < args.length; index++) {
    const key = { "--directory": "directory", "--source-thread": "sourceThreadId", "--socket": "socketPath" }[args[index]]
    if (!key || !args[index + 1]) throw new Error("Usage: node scripts/diagnose.mjs [--directory FOLDER] [--source-thread UUID] [--socket PATH]")
    options[key] = args[++index]
  }
  const adapter = createNativeCodexAdapter(options)
  try { return await adapter.diagnose(AbortSignal.timeout(10000)) }
  finally { adapter.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  diagnose().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    console.error(JSON.stringify({ connected: false, code: typeof error.code === "string" ? error.code : "diagnostic_failed",
      message: "Read-only Codex diagnostic could not complete. Check the GUI, source UUID and owner-private socket." }))
    process.exitCode = 1
  })
}
