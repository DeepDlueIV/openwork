import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { z } from "zod"
import { credentialPromptDestination, credentialPromptInstruction, credentialPromptSchema } from "@openwork/types/den/credential-prompt"
import { catalogOperationAvailableToCapabilities } from "../src/mcp/catalog-availability.js"
import { defaultBaseUrl, type ProtocolFamily } from "../../gateway/src/protocols.js"

process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-credential-prompt-test-key-0000"
process.env.BETTER_AUTH_SECRET ??= "synthetic-credential-prompt-test-secret-00"
process.env.DEN_BASE_URL ??= "https://console.example.test"
const { gatewayProviderKeyPrompt, gatewayUpstreamDestination, mcpConnectionKeyPrompt, credentialPromptResponseFields } = await import("../src/credential-prompt.js")

const sentinel = "fixture-private-value"

test("a prompt is metadata only: no field can carry a value", () => {
  const prompt = mcpConnectionKeyPrompt({ id: "emc_fixture", name: "Fixture service", url: "https://service.example/mcp?token=fixture#frag" })
  assert.equal(prompt.destination, "https://service.example/mcp")
  for (const field of ["value", "apiKey", "secret", "credential"]) {
    assert.equal(credentialPromptSchema.safeParse({ ...prompt, [field]: sentinel }).success, false)
    assert.equal(credentialPromptSchema.safeParse({ ...prompt, target: { ...prompt.target, [field]: sentinel } }).success, false)
  }
  const schema = JSON.stringify(z.toJSONSchema(credentialPromptSchema))
  for (const field of ['"value"', '"apiKey"', '"secret"']) assert.ok(!schema.includes(field))
})

test("the destination never shows URL credentials, query or fragment", () => {
  assert.equal(credentialPromptDestination("https://SERVICE.example:443/mcp?api_key=fixture#x"), "https://service.example/mcp")
  assert.equal(credentialPromptDestination("https://user:fixture@service.example/mcp"), null)
  assert.equal(credentialPromptDestination("javascript:alert(1)"), null)
  assert.equal(credentialPromptDestination(42), null)
})

test("AI Gateway destinations match the gateway's own defaults, and an explicit upstream wins", () => {
  const sdks = [
    { npm: "@ai-sdk/openai", family: "openai" }, { npm: "@ai-sdk/anthropic", family: "anthropic" },
    { npm: "@ai-sdk/mistral", family: "mistral" }, { npm: "@ai-sdk/google", family: "google" },
  ] satisfies Array<{ npm: string; family: ProtocolFamily }>
  for (const sdk of sdks) assert.equal(gatewayUpstreamDestination("fixture", { npm: sdk.npm }, {}), defaultBaseUrl(sdk.family, {}))
  assert.equal(gatewayUpstreamDestination("fixture", { npm: "@ai-sdk/azure" }, { resourceName: "example" }), defaultBaseUrl("azure", { resourceName: "example" }))
  assert.equal(gatewayUpstreamDestination("fixture", { npm: "@ai-sdk/openai", api: "https://catalog.example/v1" }, { upstreamBaseUrl: "https://override.example/v1" }), "https://override.example/v1")
  assert.equal(gatewayUpstreamDestination("fixture", { npm: "@ai-sdk/openai" }, { upstreamBaseUrl: "https://user:fixture@override.example/v1" }), null)
  assert.equal(gatewayUpstreamDestination("fixture", { npm: "unknown-sdk" }, {}), null)
})

test("the agent is told to end its turn and never to ask for the key in chat", () => {
  const prompt = gatewayProviderKeyPrompt({ inferenceProviderId: "ipr_fixture", credentialSetId: "gcs_fixture", name: "Team OpenAI", destination: "https://api.openai.com/v1" })
  const fields = credentialPromptResponseFields(prompt)
  assert.equal(fields.credentialPrompt, prompt)
  assert.match(fields.nextStep, /Never ask them to paste the key in chat/)
  assert.match(fields.nextStep, /End your turn/)
  assert.match(fields.nextStep, /https:\/\/console\.example\.test\/dashboard\/ai-gateway\?tab=ai-providers/)
  assert.match(credentialPromptInstruction(prompt, null), /^A private field for the Team OpenAI API key/)
})

test("agents are offered AI Gateway provider creation only while secure keys in chat is on", () => {
  const create = { method: "POST", path: "/v1/inference-providers" }
  const base = { generatedArtifactViewsEnabled: true, managedDeploymentsMcpEnabled: false }
  assert.equal(catalogOperationAvailableToCapabilities({ ...base, secureSecretFieldsEnabled: false }, create), false)
  assert.equal(catalogOperationAvailableToCapabilities(base, create), false)
  assert.equal(catalogOperationAvailableToCapabilities({ ...base, secureSecretFieldsEnabled: true }, create), true)
  // Other provider routes are unaffected by the rollout.
  assert.equal(catalogOperationAvailableToCapabilities({ ...base, secureSecretFieldsEnabled: false }, { method: "GET", path: "/v1/inference-providers/model-management" }), true)
})

test("the shared-key route is hidden, rollout-gated, human-only and never echoes provider text", () => {
  const source = readFileSync(new URL("../src/routes/org/mcp-connections.ts", import.meta.url), "utf8")
  const start = source.indexOf('"/v1/mcp-connections/:connectionId/shared-credential"')
  assert.ok(start > 0)
  const route = source.slice(start, source.indexOf("app.post(", start))
  assert.match(route, /describeRoute\(\{ hide: true \}\)/)
  assert.match(route, /requireFeature\("secureSecretFields"\)/)
  assert.match(route, /orgPermissionRoute\("connections\.manage"\)/)
  assert.match(route, /session\.id === "mcp_internal" \|\| c\.get\("apiKey"\)/)
  assert.ok(!route.includes("jsonValidator("), "a shared validator could echo the submitted value")
  assert.ok(!route.includes("diagnostic.message"), "provider text can repeat the submitted key")
  assert.ok(!route.includes("externalMcpDiagnosticForLog"), "provider text can repeat the submitted key")
})
