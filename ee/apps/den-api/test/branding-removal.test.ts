import assert from "node:assert/strict"
import { createPrivateKey, sign } from "node:crypto"
import { test } from "node:test"
import { z } from "zod"
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
const stockBrand = { appName: "OpenWork", logoUrl: null, iconUrl: null }
const retired = {
  brandAppName: "Old name",
  brandLogoUrl: "https://example.com/logo.png",
  brandIconUrl: "https://example.com/icon.png",
  brandAccentColor: "blue",
}
// Old desktop wire contract: fields remain required even though new desktops
// ignore them. The PR also exercises the frozen pre-removal desktop verifier.
const legacyBrandSchema = z.object({
  appName: z.string().trim().min(1).max(64),
  logoUrl: z.string().trim().url().nullable(),
  iconUrl: z.string().trim().url().nullable(),
})

function signedLegacyToken(payload: unknown, privateKeyPem: string) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "test" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const input = `${header}.${body}`
  const signature = sign(null, Buffer.from(input), createPrivateKey(privateKeyPem)).toString("base64url")
  return `${input}.${signature}`
}

test("new signed and exchange claims emit stock compatibility branding", () => {
  const keys = generateConnectLinkKeyPair()
  const token = signConnectLinkToken({ claims, privateKeyPem: keys.privateKeyPem, kid: "test" })
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
  assert.deepEqual(legacyBrandSchema.parse(payload.brand), stockBrand)
  const result = verifyConnectLinkToken({ token, publicKeys: { test: keys.publicKeyPem }, nowEpochSeconds: 1500 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.claims, { ...claims, brand: stockBrand })
  // Exchange minting/reading uses this same parser, including old stored grants.
  for (const brand of [undefined, { appName: "Old name", logoUrl: "http://old.invalid/logo", iconUrl: null }]) {
    const parsed = connectLinkClaimsSchema.parse({ ...claims, brand })
    assert.deepEqual(parsed, { ...claims, brand: stockBrand })
    assert.deepEqual(legacyBrandSchema.parse(parsed.brand), stockBrand)
  }
})

test("legacy signed brand claims are accepted and ignored without weakening token validation", () => {
  const keys = generateConnectLinkKeyPair()
  const legacy = { ...claims, brand: { appName: "Old name", logoUrl: "http://old.invalid/logo", iconUrl: null } }
  const token = signedLegacyToken(legacy, keys.privateKeyPem)
  const verify = (value: string, nowEpochSeconds = 1500) => verifyConnectLinkToken({ token: value, publicKeys: { test: keys.publicKeyPem }, nowEpochSeconds })
  const result = verify(token)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.claims, { ...claims, brand: stockBrand })
  assert.equal(result.claims.iss, claims.iss)
  assert.deepEqual(verify(token, 3000), { ok: false, code: "expired", message: "Token has expired." })
  assert.equal(verify(token, 500).ok, false)
  assert.equal(verify(`${token.split(".").slice(0, 2).join(".")}.`).ok, false)
  const tampered = token.split(".")
  tampered[1] = Buffer.from(JSON.stringify({ ...legacy, iss: "https://attacker.example.com" })).toString("base64url")
  assert.deepEqual(verify(tampered.join(".")), { ok: false, code: "bad_signature", message: "Token signature does not verify." })
  for (const patch of [{ aud: "other" }, { v: 2 }, { iss: "not-a-url" }, { den: { baseUrl: "http://untrusted.example.com" } }]) {
    assert.equal(verify(signedLegacyToken({ ...legacy, ...patch }, keys.privateKeyPem)).ok, false)
  }
})

test("Den URL security still applies when retired claims are present", () => {
  const parsed = connectLinkClaimsSchema.parse({ ...claims, brand: retired })
  assert.deepEqual(parsed.brand, stockBrand)
  const keys = generateConnectLinkKeyPair()
  assert.throws(() => signConnectLinkToken({ claims: { ...claims, den: { baseUrl: "http://untrusted.example.com" } }, privateKeyPem: keys.privateKeyPem, kid: "test" }), /non-https/)
})

test("desktop config drops retired settings while retaining policy and version controls", () => {
  const expected = { allowCustomProviders: false, allowedDesktopVersions: ["1.2.3"], connectEnabled: false }
  assert.deepEqual(normalizeDesktopConfig({ ...expected, ...retired }), expected)
  assert.deepEqual(desktopConfigSchema.parse({ ...expected, ...retired }), expected)
  assert.equal(isPermissionKey("branding.update"), false)
})

test("normalization and storage serialization preserve exact dormant metadata through unrelated writes", async () => {
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
  const { normalizeOrganizationMetadata, serializeOrganizationMetadata, withoutRetiredSettings } = await import("../src/organization-limits.ts")
  const kept = { limits: { members: 5, workers: 1 }, requireSso: true, allowedDesktopVersions: ["1.2.3"], workbot: { model: "gateway/model-a", nested: { enabled: true } } }
  const legacy = {
    ...kept,
    ...retired,
    // Preserve even dormant non-normalized values and nested asset references.
    brandAppName: "  Old name  ",
    brandLogoAsset: { version: "old", key: "assets/logo", nested: { sizes: [16, 64], metadata: { mime: "image/png" } } },
    brandIconAsset: { version: "old", key: "assets/icon" },
  }
  const original = structuredClone(legacy)
  for (const input of [legacy, JSON.stringify(legacy)]) {
    const normalized = normalizeOrganizationMetadata(input)
    assert.deepEqual(normalized.metadata, original)
    assert.equal(normalized.changed, false, "dormant branding must not trigger a lazy storage rewrite")
    assert.deepEqual(JSON.parse(serializeOrganizationMetadata(input) ?? "null"), original)
    const unrelatedWrite = { ...normalized.metadata, requireSso: false, limits: { ...normalized.metadata.limits, members: 10 } }
    const stored = JSON.parse(serializeOrganizationMetadata(unrelatedWrite) ?? "null")
    assert.deepEqual(stored, { ...original, requireSso: false, limits: { members: 10, workers: 1 } })
    assert.deepEqual(withoutRetiredSettings(normalized.metadata), kept)
  }
  const needsNormalization = { ...legacy, limits: { members: "7", Workers: "2" }, allowedDesktopVersions: ["v1.2.3"] }
  const normalized = normalizeOrganizationMetadata(needsNormalization)
  assert.equal(normalized.changed, true)
  assert.deepEqual(JSON.parse(serializeOrganizationMetadata(normalized.metadata) ?? "null"), {
    ...needsNormalization,
    limits: { members: 7, Workers: "2", workers: 2 },
    allowedDesktopVersions: ["1.2.3"],
  })
  assert.deepEqual(legacy, original, "read projection must not mutate stored metadata")
})

test("install output is old-parser compatible stock branding while bootstrap retains dormant settings", () => {
  const install = { clientName: "Example organization", webUrl: "https://example.com", apiUrl: "https://api.example.com", requireSignin: true }
  for (const input of [install, { ...install, appName: "Old name", logoUrl: "https://example.com/logo.png", iconUrl: null }]) {
    const parsed = installConfigSchema.parse(input)
    assert.deepEqual(parsed, { ...install, ...stockBrand })
    assert.deepEqual(legacyBrandSchema.parse(parsed), stockBrand)
  }
  const bootstrap = { baseUrl: "https://example.com", apiBaseUrl: "https://api.example.com", requireSignin: true, requireActivation: true, writtenAt: "2026-10-13T00:00:00.000Z" }
  const { brandAccentColor: _ignored, ...dormantBootstrapBrand } = retired
  assert.deepEqual(desktopBootstrapConfigSchema.parse({ ...bootstrap, ...retired }), { ...bootstrap, ...dormantBootstrapBrand })
})
