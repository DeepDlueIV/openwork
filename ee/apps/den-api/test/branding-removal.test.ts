import assert from "node:assert/strict"
import { createPrivateKey, sign } from "node:crypto"
import { test } from "node:test"
import { connectLinkClaimsSchema, CONNECT_LINK_AUDIENCE, CONNECT_LINK_VERSION } from "@openwork/connect-link"
import { generateConnectLinkKeyPair, signConnectLinkToken, verifyConnectLinkToken } from "@openwork/connect-link/node"
import { desktopBootstrapConfigSchema, installConfigSchema } from "@openwork/install-config"
import { desktopConfigSchema, normalizeDesktopConfig } from "@openwork/types/den/desktop-policies"
import { isPermissionKey } from "@openwork/types/den/permissions"

const claims = {
  iss: "https://api.example.com",
  aud: CONNECT_LINK_AUDIENCE,
  iat: 1000,
  exp: 2000,
  jti: "connect-test-token",
  v: CONNECT_LINK_VERSION,
  org: { name: "Example organization" },
  den: { baseUrl: "https://example.com", apiBaseUrl: "https://api.example.com" },
  requireSignin: true,
}
const retired = {
  brandAppName: "Old name",
  brandLogoUrl: "https://example.com/logo.png",
  brandIconUrl: "https://example.com/icon.png",
  brandAccentColor: "blue",
}

test("new connect links contain organization identity but no branding", () => {
  const keys = generateConnectLinkKeyPair()
  const token = signConnectLinkToken({ claims, privateKeyPem: keys.privateKeyPem, kid: "test" })
  const result = verifyConnectLinkToken({ token, publicKeys: { test: keys.publicKeyPem }, nowEpochSeconds: 1500 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.claims, claims)
  assert.equal("brand" in result.claims, false)
})

test("legacy signed brand claims are accepted and ignored, not re-signed", () => {
  const keys = generateConnectLinkKeyPair()
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "test" })).toString("base64url")
  // Brand URLs are no longer fetched or used; only the Den target remains security-sensitive.
  const payload = Buffer.from(JSON.stringify({ ...claims, brand: { appName: "Old name", logoUrl: "http://old.invalid/logo", iconUrl: null } })).toString("base64url")
  const input = `${header}.${payload}`
  const signature = sign(null, Buffer.from(input), createPrivateKey(keys.privateKeyPem)).toString("base64url")
  const result = verifyConnectLinkToken({ token: `${input}.${signature}`, publicKeys: { test: keys.publicKeyPem }, nowEpochSeconds: 1500 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.claims, claims)
  assert.equal(verifyConnectLinkToken({ token: `${input}.${signature}`, publicKeys: { test: keys.publicKeyPem }, nowEpochSeconds: 3000 }).ok, false)
})

test("Den URL security still applies when retired claims are present", () => {
  const parsed = connectLinkClaimsSchema.parse({ ...claims, brand: retired })
  assert.equal("brand" in parsed, false)
  const keys = generateConnectLinkKeyPair()
  assert.throws(() => signConnectLinkToken({ claims: { ...claims, den: { baseUrl: "http://untrusted.example.com" } }, privateKeyPem: keys.privateKeyPem, kid: "test" }), /non-https/)
})

test("desktop config drops retired settings while retaining policy and version controls", () => {
  const expected = { allowCustomProviders: false, allowedDesktopVersions: ["1.2.3"], connectEnabled: false }
  assert.deepEqual(normalizeDesktopConfig({ ...expected, ...retired }), expected)
  assert.deepEqual(desktopConfigSchema.parse({ ...expected, ...retired }), expected)
  assert.equal(isPermissionKey("branding.update"), false)
})

test("organization metadata retires branding without losing security or unrelated settings", async () => {
  for (const [key, value] of Object.entries({
    OPENWORK_DEV_MODE: "1",
    DB_MODE: "mysql",
    DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den",
    DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
    BETTER_AUTH_SECRET: "local-dev-secret-not-for-production-use!!",
    BETTER_AUTH_URL: "http://localhost:8790",
  })) {
    if (!process.env[key]?.trim()) process.env[key] = value
  }
  const { normalizeOrganizationMetadata, serializeOrganizationMetadata } = await import("../src/organization-limits.ts")
  const kept = { limits: { members: 5, workers: 1 }, requireSso: true, allowedDesktopVersions: ["1.2.3"], workbot: { model: "gateway/model-a" } }
  const legacy = { ...kept, ...retired, brandLogoAsset: { version: "old" }, brandIconAsset: { version: "old" } }
  for (const input of [legacy, JSON.stringify(legacy)]) {
    const normalized = normalizeOrganizationMetadata(input)
    assert.deepEqual(normalized.metadata, kept)
    assert.equal(normalized.changed, true)
    assert.deepEqual(JSON.parse(serializeOrganizationMetadata(input) ?? "null"), kept)
  }
})

test("install and bootstrap configs ignore old branding and retain required sign-in", () => {
  const install = { clientName: "Example organization", webUrl: "https://example.com", apiUrl: "https://api.example.com", requireSignin: true }
  assert.deepEqual(installConfigSchema.parse({ ...install, appName: "Old name", logoUrl: "https://example.com/logo.png", iconUrl: null }), install)
  const bootstrap = { baseUrl: "https://example.com", apiBaseUrl: "https://api.example.com", requireSignin: true, requireActivation: true, writtenAt: "2026-10-13T00:00:00.000Z" }
  assert.deepEqual(desktopBootstrapConfigSchema.parse({ ...bootstrap, ...retired }), bootstrap)
})
