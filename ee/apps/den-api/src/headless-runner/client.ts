import { headlessRunnerConfig, type HeadlessRunnerDeps } from "@openwork-ee/headless-protocol"
import { DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } from "../mcp/headless-run-token.js"

/**
 * Den's wiring for the shared headless runner: its address from the environment, and member-scoped MCP tokens from
 * Den's minter. The client, its schemas and the step labels live in @openwork-ee/headless-protocol.
 */
export * from "@openwork-ee/headless-protocol"

export function defaultHeadlessRunnerDeps(env: Record<string, string | undefined> = process.env): HeadlessRunnerDeps | null {
  const config = headlessRunnerConfig(env)
  // Loaded lazily: the minter pulls in the auth and database modules. A resume grant comes back only where
  // `headlessDurableTurns` is on and the turn's session and message are known.
  const mintToken: HeadlessRunnerDeps["mintToken"] = async (input) => {
    const { token, resumeGrant, modelAccess } = await (await import("./resume-grants.js")).mintHeadlessTurnCredentials(input)
    return { token, ...(resumeGrant ? { resumeGrant } : {}), ...(modelAccess ? { modelAccess } : {}) }
  }
  const modelAccessRequired: HeadlessRunnerDeps["modelAccessRequired"] = async (actor) =>
    (await import("../workbot/model.js")).cloudAgentGatewayEnabled(actor.organizationId)
  return config ? { config, fetch, mintToken, modelAccessRequired, maxTokenTtlMs: DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } : null
}
