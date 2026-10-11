import assert from "node:assert/strict"
import { test } from "node:test"
import {
  GatewayError,
  classifyProtocol,
  fetchGatewayInventory,
  fetchGatewayKey,
  gatewayBaseFromProviderApi,
  inventoryModels,
  listGatewayModels,
  modelsFor,
  providersFor,
} from "./gateway.ts"
import { DenRequestError } from "./den.ts"
import { fakeFetch, json } from "./test-fetch.ts"

const session = { apiBaseUrl: "https://den.example.com", token: "den-token", orgId: "org_1" }
const GATEWAY = "https://gateway.example.com"

const providersBody = {
  inferenceProviders: [
    {
      id: "ipr_openai",
      providerId: "openai",
      name: "OpenAI",
      credentialStatus: "ready",
      providerConfig: { npm: "@ai-sdk/openai", api: `${GATEWAY}/api/v1/providers/ipr_openai`, options: {} },
      models: [{ id: "gwm_gpt", name: "GPT", config: {}, upstreamModelId: "gpt-5" }],
    },
    {
      id: "ipr_claude",
      providerId: "anthropic",
      name: "Anthropic",
      credentialStatus: "ready",
      providerConfig: { npm: "@ai-sdk/anthropic", options: { baseURL: `${GATEWAY}/api/v1/providers/ipr_claude/` } },
      models: [{ id: "gwm_sonnet", name: "Sonnet", config: {}, upstreamModelId: "claude-sonnet-4-6" }],
    },
    {
      id: "ipr_foundry",
      providerId: "microsoft_foundry",
      name: "Foundry",
      providerConfig: {},
      models: [{ id: "gwm_foundry", name: "Foundry Claude", config: {} }],
    },
    {
      id: "ipr_gemini",
      providerId: "google",
      name: "Gemini",
      providerConfig: { npm: "@ai-sdk/google" },
      models: [{ id: "gwm_gemini", name: "Gemini", config: {} }],
    },
    { id: "ipr_empty", providerId: "openai", name: "Empty", credentialStatus: "member_auth_required", providerConfig: {}, models: [] },
    { id: "bogus", name: "Bogus", models: [{ id: "gwm_x", name: "X" }] },
  ],
}

test("classifies by npm first, then provider family", () => {
  assert.equal(classifyProtocol({ npm: "@ai-sdk/anthropic" }), "anthropic_messages")
  assert.equal(classifyProtocol({ npm: "@ai-sdk/google-vertex/anthropic" }), "anthropic_messages")
  assert.equal(classifyProtocol({ npm: "@ai-sdk/openai-compatible" }), "openai_responses")
  assert.equal(classifyProtocol({ npm: "@ai-sdk/azure", family: "anthropic" }), "openai_responses")
  assert.equal(classifyProtocol({ npm: "@ai-sdk/google", family: "google" }), "other")
  assert.equal(classifyProtocol({ family: "google_vertex_anthropic" }), "anthropic_messages")
  assert.equal(classifyProtocol({ family: "bedrock-mantle" }), "openai_responses")
  assert.equal(classifyProtocol({}), "other")
})

test("derives the gateway base from providerConfig.api", () => {
  assert.equal(gatewayBaseFromProviderApi(`${GATEWAY}/api/v1/providers/ipr_a`, "ipr_a"), GATEWAY)
  assert.equal(gatewayBaseFromProviderApi(`${GATEWAY}/prefix/api/v1/providers/ipr_a/`, "ipr_a"), `${GATEWAY}/prefix`)
  assert.equal(gatewayBaseFromProviderApi(`${GATEWAY}/api/v1/providers/ipr_b`, "ipr_a"), null)
  assert.equal(gatewayBaseFromProviderApi("http://gateway.example.com/api/v1/providers/ipr_a", "ipr_a"), null)
  assert.equal(gatewayBaseFromProviderApi(null, "ipr_a"), null)
})

test("inventory keeps usable providers, classified and sorted", async () => {
  const { fetch, calls } = fakeFetch({ "GET /v1/inference-providers?scope=usable": () => json(200, providersBody) })
  const inventory = await fetchGatewayInventory(session, { fetch })
  assert.equal(calls[0]?.headers["x-openwork-org-id"], "org_1")
  assert.equal(inventory.gatewayBaseUrl, GATEWAY)
  assert.deepEqual(
    inventory.providers.map((provider) => [provider.id, provider.protocol]),
    [["ipr_claude", "anthropic_messages"], ["ipr_foundry", "anthropic_messages"], ["ipr_gemini", "other"], ["ipr_openai", "openai_responses"]],
  )
  assert.deepEqual(providersFor(inventory, "openai_responses").map((provider) => provider.id), ["ipr_openai"])
  assert.deepEqual(modelsFor(inventoryModels(inventory), "anthropic_messages").map((model) => model.id), ["gwm_sonnet", "gwm_foundry"])
})

test("deployments without a gateway yield an empty inventory; other errors propagate", async () => {
  for (const status of [404, 405, 501]) {
    const { fetch } = fakeFetch({ "GET /v1/inference-providers?scope=usable": () => json(status, {}) })
    assert.deepEqual(await fetchGatewayInventory(session, { fetch }), { gatewayBaseUrl: null, providers: [] })
  }
  const { fetch } = fakeFetch({ "GET /v1/inference-providers?scope=usable": () => json(500, {}) })
  await assert.rejects(fetchGatewayInventory(session, { fetch }), DenRequestError)
})

test("fetchGatewayKey returns only ow_gw_ keys", async () => {
  const { fetch } = fakeFetch({
    "GET /v1/inference-providers/ipr_openai/connect": () => json(200, { inferenceProvider: { id: "ipr_openai", apiKey: "ow_gw_member" } }),
    "GET /v1/inference-providers/ipr_bad/connect": () => json(200, { inferenceProvider: { id: "ipr_bad", apiKey: "sk-upstream" } }),
  })
  assert.equal(await fetchGatewayKey(session, "ipr_openai", { fetch }), "ow_gw_member")
  await assert.rejects(fetchGatewayKey(session, "ipr_bad", { fetch }), (error: unknown) => {
    assert.ok(error instanceof GatewayError)
    assert.doesNotMatch(error.message, /sk-upstream/)
    return true
  })
  await assert.rejects(fetchGatewayKey(session, "../x", { fetch }), GatewayError)
})

test("gateway models join Den's inventory by ipr, falling back to owned_by", async () => {
  const den = fakeFetch({ "GET /v1/inference-providers?scope=usable": () => json(200, providersBody) })
  const inventory = await fetchGatewayInventory(session, { fetch: den.fetch })
  const { fetch, calls } = fakeFetch({
    "GET /api/v1/models": () => json(200, {
      data: [
        { id: "gwm_sonnet", name: "Sonnet", owned_by: "openai", openwork: { provider_id: "ipr_claude", provider_name: "Anthropic", upstream_model_id: "claude-sonnet-4-6" } },
        { id: "gwm_gpt", name: "GPT", owned_by: "openai", openwork: { provider_id: "ipr_openai" } },
        { id: "gwm_new", name: "New", owned_by: "google_vertex_anthropic", openwork: { provider_id: "ipr_unknown" } },
        { id: "gwm_az", owned_by: "azure" },
        { id: "gwm_gem", owned_by: "google" },
      ],
    }),
  })
  const models = await listGatewayModels(`${GATEWAY}/`, "ow_gw_member", { fetch, inventory })
  assert.equal(calls[0]?.url, `${GATEWAY}/api/v1/models`)
  assert.equal(calls[0]?.headers.authorization, "Bearer ow_gw_member")
  assert.equal(calls[0]?.redirect, "error")
  const byId = new Map(models.map((model) => [model.id, model]))
  // Den's npm wins over a misleading owned_by.
  assert.equal(byId.get("gwm_sonnet")?.protocol, "anthropic_messages")
  assert.equal(byId.get("gwm_sonnet")?.upstreamModelId, "claude-sonnet-4-6")
  assert.equal(byId.get("gwm_gpt")?.protocol, "openai_responses")
  assert.equal(byId.get("gwm_new")?.protocol, "anthropic_messages")
  assert.equal(byId.get("gwm_az")?.protocol, "openai_responses")
  assert.equal(byId.get("gwm_az")?.name, "gwm_az")
  assert.equal(byId.get("gwm_gem")?.protocol, "other")
  assert.deepEqual(modelsFor(models, "anthropic_messages").map((model) => model.id), ["gwm_new", "gwm_sonnet"])
})

test("gateway errors never include the key and refuse plain HTTP", async () => {
  const { fetch, calls } = fakeFetch({ "GET /api/v1/models": () => json(401, { error: "invalid_api_key", key: "ow_gw_member" }) })
  await assert.rejects(listGatewayModels(GATEWAY, "ow_gw_member", { fetch }), (error: unknown) => {
    assert.ok(error instanceof GatewayError)
    assert.equal(error.status, 401)
    assert.equal(error.code, "invalid_api_key")
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /ow_gw_member/)
    return true
  })
  await assert.rejects(listGatewayModels("http://gateway.example.com", "ow_gw_member", { fetch }), /https/)
  assert.equal(calls.length, 1)
})
