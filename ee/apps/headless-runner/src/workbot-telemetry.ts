/** Bounded product facts only. The member identity comes from the turn's MCP token at Den. */
export type WorkbotTurnFact = {
  event: "accepted"
  sessionId: string
  messageId: string
  timestamp: number
  model: string
  attachmentCount: number
  hasContext: boolean
} | {
  event: "completed" | "failed" | "aborted"
  sessionId: string
  messageId: string
  timestamp: number
  attempt: number
  model: string
  modelSource: "response" | "configured"
  errorCode: string | null
}

export function isWorkbotTurn(sessionId: string, messageId: string) {
  return /^hs_wbs?_[a-f0-9]{40}$/.test(sessionId) && /^(?:wb_hello|wb_[A-Za-z0-9_-]{8,64})$/.test(messageId)
}

/** Uses existing service configuration, never a callback URL from a turn or model output. */
export function workbotTelemetryReporter(config: { apiToken: string; mcp?: { url: string } }) {
  if (!config.mcp) return undefined
  const url = new URL("/v1/workbot/telemetry", config.mcp.url).toString()
  return async (fact: WorkbotTurnFact, token: string) => {
    try {
      const response = await fetch(url, {
        method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${token}`, "x-openwork-workbot-service": config.apiToken, "content-type": "application/json" },
        body: JSON.stringify(fact), signal: AbortSignal.timeout(2_000),
      })
      if (!response.ok) console.warn("[workbot] telemetry_delivery_failed", { status: response.status })
    } catch {
      // Never affect a turn and never log credentials or response bodies.
      console.warn("[workbot] telemetry_delivery_failed")
    }
  }
}
