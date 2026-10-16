import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { bootDen, type Member } from "./harness.js"

const RENDER_URL = "https://mcp.render.com/mcp"
const den = await bootDen({ env: {
  DEN_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS: JSON.stringify({ [RENDER_URL]: { clientId: "openwork" } }),
} })
const { db } = await import("../../src/db.js")
const schema = await import("@openwork-ee/den-db/schema")
const drizzle = await import("@openwork-ee/den-db/drizzle")
const oauthCredentials = await import("../../src/capability-sources/oauth-credentials.js")
let organizationId = ""
let admin: Member

before(async () => {
  const owner = await den.signUp("Preregistered Admin")
  const created = await den.createOrg(owner, "Preregistered Org")
  organizationId = created.orgId
  admin = created.owner
})
after(() => den.close())

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error("Expected a JSON object response")
  return body
}
function adminRequest(path: string, init: { method?: string; body?: Record<string, unknown> } = {}) {
  return den.app.fetch(new Request(`http://127.0.0.1:8790${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${admin.token}`,
      "x-openwork-org-id": organizationId,
      origin: "http://localhost:3005",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  }))
}

describe("deployment-supplied pre-registered OAuth clients", () => {
  test("the Render preset no longer demands an admin OAuth app", async () => {
    const response = await adminRequest("/v1/mcp-connections/presets")
    assert.equal(response.status, 200)
    const body = await responseRecord(response)
    const presets = body.presets
    if (!Array.isArray(presets)) throw new Error("Presets response did not include presets")
    const render = presets.find((preset) => isRecord(preset) && preset.presetId === "render")
    assert.partialDeepStrictEqual(render, { url: RENDER_URL, authType: "oauth", supportedAuthTypes: ["oauth", "apikey"] })
    assert.equal(isRecord(render) && "requiresOAuthClient" in render, false)
    const slack = presets.find((preset) => isRecord(preset) && preset.presetId === "slack")
    assert.equal(isRecord(slack) && slack.requiresOAuthClient, true)
  })

  test("creating an OAuth connection stores the deployment client as pre-registered", async () => {
    const response = await adminRequest("/v1/mcp-connections", {
      method: "POST",
      body: {
        name: "Render",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "per_member",
      },
    })
    assert.equal(response.status, 200)
    const body = await responseRecord(response)
    assert.partialDeepStrictEqual(body, {
      authType: "oauth",
      oauthClientConfigured: true,
      oauthClientRequired: false,
      oauthClientId: "openwork",
      oauthRegistrationSource: "pre-registered",
      setupRequired: false,
    })
    assert.equal(body.oauthCallbackUrl, "http://127.0.0.1:8790/v1/mcp-connections/oauth/callback")

    const connectionId = body.id
    if (typeof connectionId !== "string") throw new Error("Created connection has no id")
    const client = await oauthCredentials.getOrgOAuthClient(organizationId, connectionId)
    assert.equal(client?.clientId, "openwork")
    assert.equal(client?.clientSecret, null)
    assert.partialDeepStrictEqual(client?.extra, {
      enterpriseMcpRegistrationSource: "pre-registered",
      registeredRedirectUri: "http://127.0.0.1:8790/v1/mcp-connections/oauth/callback",
    })
  })

  test("an admin-supplied OAuth app still wins over the deployment client", async () => {
    const response = await adminRequest("/v1/mcp-connections", {
      method: "POST",
      body: {
        name: "Render with own app",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "per_member",
        oauthClient: { clientId: "custom-render-client" },
      },
    })
    assert.equal(response.status, 200)
    const body = await responseRecord(response)
    assert.equal(body.oauthClientId, "custom-render-client")
  })

  test("servers without a deployment client are unaffected", async () => {
    const response = await adminRequest("/v1/mcp-connections", {
      method: "POST",
      body: {
        name: "Slack",
        url: "https://mcp.slack.com/mcp",
        authType: "oauth",
        credentialMode: "per_member",
      },
    })
    assert.equal(response.status, 200)
    const body = await responseRecord(response)
    assert.partialDeepStrictEqual(body, { oauthClientConfigured: false, oauthClientRequired: true, oauthClientId: null })
  })

  test("switching an API-key connection to OAuth on edit fills in the deployment client", async () => {
    const created = await adminRequest("/v1/mcp-connections", {
      method: "POST",
      body: {
        name: "Render shared",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "shared",
        oauthClient: { clientId: "custom-render-client" },
      },
    })
    assert.equal(created.status, 200)
    const createdBody = await responseRecord(created)
    const connectionId = createdBody.id
    if (typeof connectionId !== "string" || typeof createdBody.updatedAt !== "string") throw new Error("Created connection is incomplete")

    // Remove the admin app so the row has no stored client, then save an edit.
    await db.delete(schema.OrgOAuthClientTable).where(drizzle.and(
      drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId),
      drizzle.eq(schema.OrgOAuthClientTable.providerId, connectionId),
    ))
    const edited = await adminRequest(`/v1/mcp-connections/${connectionId}`, {
      method: "PUT",
      body: {
        expectedUpdatedAt: createdBody.updatedAt,
        name: "Render shared (renamed)",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "per_member",
        access: { orgWide: true, memberIds: [], teamIds: [] },
      },
    })
    assert.equal(edited.status, 200)
    const editedBody = await responseRecord(edited)
    assert.partialDeepStrictEqual(editedBody, { oauthClientConfigured: true, oauthClientId: "openwork", oauthRegistrationSource: "pre-registered" })
  })

  test("a stored admin OAuth app survives a plain edit and is replaced only when the identity changes", async () => {
    const created = await adminRequest("/v1/mcp-connections", {
      method: "POST",
      body: {
        name: "Render custom",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "per_member",
        oauthClient: { clientId: "custom-render-client" },
      },
    })
    assert.equal(created.status, 200)
    const createdBody = await responseRecord(created)
    const connectionId = createdBody.id
    if (typeof connectionId !== "string" || typeof createdBody.updatedAt !== "string") throw new Error("Created connection is incomplete")

    const renamed = await adminRequest(`/v1/mcp-connections/${connectionId}`, {
      method: "PUT",
      body: {
        expectedUpdatedAt: createdBody.updatedAt,
        name: "Render custom (renamed)",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "per_member",
        access: { orgWide: true, memberIds: [], teamIds: [] },
      },
    })
    assert.equal(renamed.status, 200)
    const renamedBody = await responseRecord(renamed)
    assert.equal(renamedBody.oauthClientId, "custom-render-client")
    if (typeof renamedBody.updatedAt !== "string") throw new Error("Renamed connection has no updatedAt")

    // Switching credential mode changes the connection identity, which drops
    // the stored client; the deployment client fills the gap.
    const switched = await adminRequest(`/v1/mcp-connections/${connectionId}`, {
      method: "PUT",
      body: {
        expectedUpdatedAt: renamedBody.updatedAt,
        name: "Render custom (renamed)",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "shared",
        access: { orgWide: true, memberIds: [], teamIds: [] },
      },
    })
    assert.equal(switched.status, 200)
    const switchedBody = await responseRecord(switched)
    assert.partialDeepStrictEqual(switchedBody, { oauthClientConfigured: true, oauthClientId: "openwork" })
  })
})
