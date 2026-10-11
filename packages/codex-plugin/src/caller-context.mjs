const record = value => value !== null && typeof value === "object" && !Array.isArray(value)
const nonempty = value => typeof value === "string" && value.trim().length > 0

/** Presence-only probe. Caller correlation is not authorization or a reusable credential. */
export function diagnoseCallerContext(metadata, environment = process.env) {
  const source = record(metadata) ? metadata : {}
  let turn = source["x-codex-turn-metadata"]
  if (typeof turn === "string") {
    try { turn = turn.length <= 4096 ? JSON.parse(turn) : null } catch { turn = null }
  }
  if (!record(turn)) turn = {}
  const present = keys => keys.some(key => nonempty(source[key]))
  return {
    hasNativeAppToolsPipe: nonempty(environment.CODEX_APP_TOOLS_PIPE_PATH),
    hasNativeNodeRuntime: nonempty(environment.CODEX_MCP_NODE_PATH) || nonempty(environment.CODEX_BROWSER_USE_NODE_PATH),
    hasCodexTurnMetadata: nonempty(turn.thread_id) && nonempty(turn.turn_id),
    hasThreadCorrelation: nonempty(turn.thread_id) || present(["openai/threadId", "openai/thread_id", "codexThreadId", "codex_thread_id", "threadId", "thread_id"]),
    hasTurnCorrelation: nonempty(turn.turn_id) || present(["openai/turnId", "openai/turn_id", "codexTurnId", "codex_turn_id", "turnId", "turn_id"]),
    hasCallCorrelation: present(["openai/toolCallId", "openai/tool_call_id", "codexCallId", "codex_call_id", "callId", "call_id"]),
    message: "Presence checks only. No caller IDs, pipe paths, credentials or transcripts are returned. Metadata alone does not authorize native creation or background control.",
  }
}
