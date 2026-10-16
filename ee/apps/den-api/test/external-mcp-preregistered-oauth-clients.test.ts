import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { EnterpriseMcpConnectionRequirements } from "@openwork/enterprise-mcp-client"
import { pluginMcpRequiresPreRegisteredOAuthClient } from "../src/capability-sources/external-mcp-auth-policy.js"
import {
  applyPreRegisteredOAuthClientDefaults,
  applyPreRegisteredOAuthClientToRequirements,
  EMPTY_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS,
  parseExternalMcpPreRegisteredOAuthClients,
  preRegisteredOAuthClientForUrl,
} from "../src/capability-sources/external-mcp-preregistered-oauth-clients.js"
import { EXTERNAL_MCP_PRESETS } from "../src/capability-sources/external-mcp-presets.js"

const RENDER_URL = "https://mcp.render.com/mcp"

function renderClients(raw = `{"${RENDER_URL}":{"clientId":"openwork"}}`) {
  return parseExternalMcpPreRegisteredOAuthClients(raw)
}

function oauthRequirements(overrides: Partial<EnterpriseMcpConnectionRequirements> = {}): EnterpriseMcpConnectionRequirements {
  return {
    status: "manual_action_required",
    server: { url: RENDER_URL, initialize: "authentication_required" },
    authentication: {
      kind: "oauth",
      authorizationServers: [{ issuer: "https://api.render.com", clientIdMetadataDocumentSupported: false }],
      requiredScopes: [],
      recommendedScopes: [],
      refreshSupport: "unknown",
      availableRegistrationMethods: ["pre_registered"],
      recommendedRegistrationMethod: "pre_registered",
    },
    tools: { visibility: "requires_auth" },
    manualRequirements: [
      {
        code: "oauth_client_registration",
        label: "Register an OAuth client",
        reason: "The authorization server does not advertise client metadata documents or dynamic registration.",
        required: true,
      },
      { code: "provider_access", label: "Provider access", reason: "Not described by metadata.", required: false },
      { code: "network_trust", label: "Network trust", reason: "Confirm in the deployment.", required: false },
    ],
    warnings: [],
    ...overrides,
  }
}

describe("DEN_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS parsing", () => {
  test("an unset or blank value configures no clients", () => {
    assert.equal(parseExternalMcpPreRegisteredOAuthClients(undefined).size, 0)
    assert.equal(parseExternalMcpPreRegisteredOAuthClients("   ").size, 0)
  })

  test("parses a public client keyed by normalized server URL", () => {
    const clients = renderClients(`{"https://MCP.render.com:443/mcp/":{"clientId":"openwork"}}`)
    assert.deepEqual([...clients.keys()], [RENDER_URL])
    assert.deepEqual(preRegisteredOAuthClientForUrl("https://mcp.render.com/mcp/", clients), { clientId: "openwork" })
    assert.equal(preRegisteredOAuthClientForUrl("https://mcp.render.com/other", clients), null)
    assert.equal(preRegisteredOAuthClientForUrl("http://mcp.render.com/mcp", clients), null)
    assert.equal(preRegisteredOAuthClientForUrl("not a url", clients), null)
    assert.equal(preRegisteredOAuthClientForUrl(RENDER_URL, EMPTY_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS), null)
  })

  test("keeps a confidential client's secret and token endpoint auth method", () => {
    const clients = renderClients(JSON.stringify({
      [RENDER_URL]: { clientId: "openwork", clientSecret: "s3cret", tokenEndpointAuthMethod: "client_secret_post" },
    }))
    assert.deepEqual(preRegisteredOAuthClientForUrl(RENDER_URL, clients), {
      clientId: "openwork",
      clientSecret: "s3cret",
      tokenEndpointAuthMethod: "client_secret_post",
    })
  })

  test("rejects malformed configuration at startup", () => {
    assert.throws(() => parseExternalMcpPreRegisteredOAuthClients("{not json"), /JSON object/)
    assert.throws(() => parseExternalMcpPreRegisteredOAuthClients(`["https://mcp.render.com/mcp"]`), /is invalid/)
    assert.throws(() => parseExternalMcpPreRegisteredOAuthClients(`{"${RENDER_URL}":{"clientId":""}}`), /is invalid at/)
    assert.throws(() => parseExternalMcpPreRegisteredOAuthClients(`{"${RENDER_URL}":{"clientId":"x","extra":1}}`), /is invalid/)
    assert.throws(() => parseExternalMcpPreRegisteredOAuthClients(`{"http://mcp.render.com/mcp":{"clientId":"x"}}`), /absolute https/)
    assert.throws(() => parseExternalMcpPreRegisteredOAuthClients(`{"${RENDER_URL}?x=1":{"clientId":"x"}}`), /absolute https/)
    assert.throws(() => parseExternalMcpPreRegisteredOAuthClients(
      `{"${RENDER_URL}":{"clientId":"a"},"${RENDER_URL}/":{"clientId":"b"}}`,
    ), /more than once/)
    assert.throws(() => parseExternalMcpPreRegisteredOAuthClients(
      `{"${RENDER_URL}":{"clientId":"x","tokenEndpointAuthMethod":"client_secret_basic"}}`,
    ), /without a clientSecret/)
  })
})

describe("deployment-supplied OAuth clients and presets", () => {
  test("a preset stops demanding an admin OAuth app when the deployment supplies one", () => {
    // Render now ships a public client; also exercise a deployment where the app must be supplied.
    const needsClient = EXTERNAL_MCP_PRESETS.map((preset) => preset.presetId === "render" ? { ...preset, requiresOAuthClient: true } : preset)
    const render = needsClient.find((preset) => preset.presetId === "render")
    assert.partialDeepStrictEqual(render, { authType: "oauth", supportedAuthTypes: ["oauth", "apikey"], requiresOAuthClient: true })
    assert.equal(pluginMcpRequiresPreRegisteredOAuthClient(RENDER_URL, needsClient), true)

    const presets = applyPreRegisteredOAuthClientDefaults(needsClient, renderClients())
    const renderForDeployment = presets.find((preset) => preset.presetId === "render")
    assert.equal(renderForDeployment?.requiresOAuthClient, undefined)
    assert.partialDeepStrictEqual(renderForDeployment, { authType: "oauth", supportedAuthTypes: ["oauth", "apikey"], url: RENDER_URL })
    assert.equal(pluginMcpRequiresPreRegisteredOAuthClient(RENDER_URL, presets), false)

    // Other presets that need an admin-supplied app are untouched.
    assert.equal(presets.find((preset) => preset.presetId === "slack")?.requiresOAuthClient, true)
    assert.equal(presets.find((preset) => preset.presetId === "github")?.requiresOAuthClient, true)
    assert.equal(pluginMcpRequiresPreRegisteredOAuthClient("https://mcp.slack.com/mcp", presets), true)
  })

  test("without configured clients presets are returned unchanged", () => {
    const presets = applyPreRegisteredOAuthClientDefaults(EXTERNAL_MCP_PRESETS, EMPTY_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS)
    assert.deepEqual(presets, EXTERNAL_MCP_PRESETS)
  })
})

describe("deployment-supplied OAuth clients and requirements discovery", () => {
  test("downgrades the registration blocker and reads as ready", () => {
    const result = applyPreRegisteredOAuthClientToRequirements(oauthRequirements(), { clientId: "openwork" })
    assert.equal(result.status, "ready")
    const registration = result.manualRequirements.find((requirement) => requirement.code === "oauth_client_registration")
    assert.equal(registration?.required, false)
    assert.ok(registration?.reason.includes("pre-registered OAuth client"))
    assert.deepEqual(result.manualRequirements.map((requirement) => requirement.code), [
      "oauth_client_registration",
      "provider_access",
      "network_trust",
    ])
  })

  test("leaves other blockers and non-OAuth results alone", () => {
    const requirements = oauthRequirements()
    assert.equal(applyPreRegisteredOAuthClientToRequirements(requirements, null), requirements)

    const withIssuerChoice = oauthRequirements({
      manualRequirements: [
        { code: "authorization_server_selection", label: "Choose an authorization server", reason: "Several issuers.", required: true },
        ...oauthRequirements().manualRequirements,
      ],
    })
    const result = applyPreRegisteredOAuthClientToRequirements(withIssuerChoice, { clientId: "openwork" })
    assert.equal(result.status, "manual_action_required")
    assert.equal(result.manualRequirements.find((requirement) => requirement.code === "authorization_server_selection")?.required, true)

    const alreadyReady = oauthRequirements({
      status: "ready",
      manualRequirements: oauthRequirements().manualRequirements.filter((requirement) => requirement.code !== "oauth_client_registration"),
    })
    assert.equal(applyPreRegisteredOAuthClientToRequirements(alreadyReady, { clientId: "openwork" }), alreadyReady)
  })
})
