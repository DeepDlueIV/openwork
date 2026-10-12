import { hasAlternateModelSelection } from "./model-selection.js"
import type { ProtocolFamily } from "./protocols.js"

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isInlineInputPart(part: unknown) {
  if (!isJsonObject(part)) return false
  if (part.type === "input_text") return typeof part.text === "string"
  // A data URL carries the image inline; a remote or file reference does not.
  return part.type === "input_image" && typeof part.image_url === "string" && part.image_url.startsWith("data:")
}

// Clients such as Codex give every replayed item an id, even with store:false.
// Only items whose complete content is inline are accepted; an id alone never
// refers to provider-stored state here.
function isInlineToolOutput(output: unknown) {
  return typeof output === "string" || (Array.isArray(output) && output.every(isInlineInputPart))
}

function isInlineResponseItem(item: JsonObject) {
  if (typeof item.call_id === "string") {
    // Client-executed tool calls and their results replayed from the client's own history.
    if (item.type === "function_call") return typeof item.name === "string" && typeof item.arguments === "string"
    if (item.type === "custom_tool_call") return typeof item.name === "string" && typeof item.input === "string"
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") return isInlineToolOutput(item.output)
  }
  if (typeof item.id !== "string" || !item.id) return false
  if (item.type === "message") {
    if (!Array.isArray(item.content) || item.content.length === 0) return false
    if (item.role === "assistant") return item.content.every((part) => isJsonObject(part) && (
      (part.type === "output_text" && typeof part.text === "string")
      || (part.type === "refusal" && typeof part.refusal === "string")
    ))
    return (item.role === "user" || item.role === "developer" || item.role === "system") && item.content.every(isInlineInputPart)
  }
  return item.type === "reasoning" && typeof item.encrypted_content === "string" && item.encrypted_content.trim().length > 0
    && Array.isArray(item.summary) && item.summary.every((part) => isJsonObject(part) && part.type === "summary_text" && typeof part.text === "string")
}

function isClientExecutedOpenAiTool(tool: JsonObject, nested = false): boolean {
  if (tool.type === "function" || tool.type === "custom") return true
  // A namespace only groups client-executed tools for the model. It never
  // nests another namespace or carries a hosted tool.
  return !nested && tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)
    && tool.tools.every((child) => isJsonObject(child) && isClientExecutedOpenAiTool(child, true))
}

export function unsupportedGatewayPayload(body: JsonObject, family: ProtocolFamily, providerId: string): "resource" | "model" | null {
  // Grants cover models, not ownership of provider-side state. Walk protocol
  // envelopes, never interpret user text or client function schemas/arguments.
  const pending: unknown[] = [body]
  const resourceFields = new Set([
    "previousresponseid", "responseid", "conversation", "conversationid", "threadid", "assistantid",
    "fileid", "fileids", "fileuri", "fileurl", "vectorstoreid", "vectorstoreids", "container", "containerid",
    "cachedcontent", "cachename", "s3location", "s3uri", "gcsuri", "toolresources", "datasources",
    "mcpservers", "connectorid", "promptarn", "sessionid", "guardrailidentifier",
  ])
  while (pending.length) {
    const value = pending.pop()
    if (Array.isArray(value)) { for (const item of value) pending.push(item); continue }
    if (!isJsonObject(value)) continue
    if ((value !== body && Object.hasOwn(value, "model")) || hasAlternateModelSelection(value, providerId)) return "model"
    if (value.type === "item_reference") return "resource"
    for (const [key, child] of Object.entries(value)) {
      if (value !== body && ((value.type === "tool_use" && key === "input" && ["anthropic", "google_vertex_anthropic", "microsoft_foundry", "bedrock"].includes(family)) || (value.type === "function_call" && key === "arguments"))) continue
      if (resourceFields.has(key.replace(/_/g, "").toLowerCase())) return "resource"
      if (key === "prompt" && isJsonObject(child)) return "resource" // Saved OpenAI prompt templates.
      if (key === "audio" && isJsonObject(child) && Object.hasOwn(child, "id")) return "resource"
      if (key === "input" && Array.isArray(child) && child.some((item) => isJsonObject(item) && Object.hasOwn(item, "id")
        && !isInlineResponseItem(item))) return "resource"
      if (key === "tool_choice" && isJsonObject(child) && (typeof child.type !== "string" || !["auto", "none", "required", "any", "tool", "function", "custom", "allowed_tools"].includes(child.type))) return "resource"
      if (key === "tools") {
        if (!Array.isArray(child)) return "resource"
        for (const tool of child) {
          if (!isJsonObject(tool)) return "resource"
          switch (family) {
            case "google":
            case "google_vertex":
              if (!Object.keys(tool).every((name) => name === "functionDeclarations" || name === "function_declarations")) return "resource"
              break
            case "bedrock":
              if (isJsonObject(tool.toolSpec) && Object.keys(tool).every((name) => name === "toolSpec")) break
              // Bedrock InvokeModel also accepts Anthropic's native client tools.
            case "anthropic":
            case "google_vertex_anthropic":
            case "microsoft_foundry":
              if (tool.type !== undefined && tool.type !== "custom") return "resource"
              if (typeof tool.name !== "string" || !isJsonObject(tool.input_schema)) return "resource"
              break
            default:
              if (!isClientExecutedOpenAiTool(tool)) return "resource"
          }
        }
        continue
      }
      if (key === "functionResponse" || key === "function_response") {
        // Function result JSON is client data, but multimodal result parts can
        // still ask Google to read a provider-owned file.
        if (isJsonObject(child)) pending.push(child.parts)
        continue
      }
      // client_metadata is opaque caller telemetry (Codex sends its own
      // thread/session ids there); like metadata it never selects provider state.
      if ([
        "metadata", "client_metadata", "schema", "input_schema", "output_schema", "response_format",
        "responseSchema", "response_schema", "responseJsonSchema", "response_json_schema",
        "functions", "functionCall", "function_call", "tool_calls", "toolUse", "json",
      ].includes(key)) continue
      pending.push(child)
    }
  }
  return null
}
