import { createApp } from "./app.js"
import { SessionEvents } from "./events.js"
import { diskBlobStore, s3BlobStore } from "./blobs.js"
import { createErrorReporter } from "./error-reporting.js"
import { REACTION_TOOL_NAMES } from "./reactions.js"
import { TASK_TOOL_NAMES } from "./tasks.js"
import { mediaTypeFor, SavedFiles, SAVED_FILE_TOOL_NAMES } from "./saved-files.js"
import type { Config } from "./config.js"
import { FILE_TOOL_NAMES } from "./files.js"
import { remoteMcpConnector } from "./mcp.js"
import { anthropicModel, openAIModel, openAIResponsesModel } from "./model.js"
import { gatewayModelCatalog } from "./model-catalog.js"
import { createModelProbe } from "./model-probe.js"
export { gatewayModelCatalog } from "./model-catalog.js"
import { Runner } from "./runner.js"
import { workbotTelemetryReporter } from "./workbot-telemetry.js"
import type { Store } from "./store.js"
import { readToolFile } from "./tool-files.js"
import type { SessionComputer } from "./types.js"

/** Both hosts build the same runner, tools, file store and live events; only SQLite ownership differs. */
export async function createRuntime(config: Config, store: Store) {
  const errors = createErrorReporter(config.errorReporting)
  let recovered: number
  try {
    recovered = store.recoverInterruptedTurns()
  } catch (error) {
    // Startup stops here; wait for the report (it gives up after a few seconds) before failing.
    await errors.report({ code: "startup_recovery_failed", error })
    throw error
  }
  const events = new SessionEvents()
  const blobs = config.files.kind === "disk" ? diskBlobStore(config.files.directory) : config.files.kind === "s3" ? s3BlobStore(config.files) : null
  const files = blobs ? new SavedFiles(store, blobs, config.fileLimits) : undefined
  // Provider SDKs load only when configured, including on the Worker host.
  let computer: SessionComputer | undefined
  if (config.computer) {
    const { Computers, createComputerProvider } = await import("@openwork-ee/headless-computer")
    computer = new Computers({ ...config.computer, provider: await createComputerProvider(config.computer) }, {
      files,
      readFile: (file, counts) => readToolFile({ name: file.name, mimeType: mediaTypeFor(file.name), data: Buffer.from(file.bytes).toString("base64") }, counts),
    })
  }
  store.onChange = (sessionId, messageId, status) => events.emit(sessionId, { type: "changed", messageId, ...(status ? { status } : {}) })
  // A native Workers fetch needs its global receiver; model adapters invoke their injected fetch as a method.
  const modelFetch: typeof fetch = (input, init) => fetch(input, init)
  const runner = new Runner({
    store,
    model:
      config.model.protocol === "anthropic"
        ? anthropicModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens, fetch: modelFetch })
        : config.model.protocol === "openai-responses"
          ? openAIResponsesModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens, fetch: modelFetch })
          : openAIModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens, fetch: modelFetch }),
    defaultModel: config.model.model,
    defaultModelApiKey: config.model.defaultApiKey,
    mcp: config.mcp
      ? remoteMcpConnector({
          url: config.mcp.url,
          allowlist: config.mcp.toolAllowlist,
          reservedNames: new Set([...FILE_TOOL_NAMES, ...SAVED_FILE_TOOL_NAMES, ...REACTION_TOOL_NAMES, ...TASK_TOOL_NAMES, ...(computer?.toolNames ?? []), ...(computer?.desktopTools?.map(tool => tool.name) ?? [])]),
        })
      : undefined,
    limits: config.limits,
    systemPrompt: config.systemPrompt,
    events,
    files,
    computer,
    errors,
    workbotTelemetry: workbotTelemetryReporter(config),
  })
  const app = createApp({ store, runner, apiToken: config.apiToken, models: gatewayModelCatalog(config), modelProbe: createModelProbe(config, modelFetch), events, files, computer, errors })
  return { app, runner, recovered, blobKind: blobs?.kind ?? "off", computer }
}
