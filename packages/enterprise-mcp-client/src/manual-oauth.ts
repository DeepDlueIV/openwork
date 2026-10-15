import { z } from "zod"
import type { OAuthDiscoveryState } from "@modelcontextprotocol/client"

/** Static administrator configuration, never populated from discovery at runtime. */
export const manualOAuthEndpointSchema = z.string().trim().url().max(2048).refine((value) => {
  try {
    const url = new URL(value)
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
    return !url.username && !url.password && !url.hash
      && (url.protocol === "https:" || (url.protocol === "http:" && loopback))
  } catch { return false }
}, "Use HTTPS (HTTP is allowed only on localhost), without URL credentials or fragments.").transform((value) => new URL(value).href)

export const manualOAuthEndpointsSchema = z.object({
  authorizationEndpoint: manualOAuthEndpointSchema,
  tokenEndpoint: manualOAuthEndpointSchema,
}).strict()

export type ManualOAuthEndpoints = z.infer<typeof manualOAuthEndpointsSchema>

/** SDK adapter for a static endpoint tuple. This is not discovered metadata. */
export function manualOAuthState(endpoints: ManualOAuthEndpoints, resource: string): OAuthDiscoveryState {
  const issuer = new URL(endpoints.authorizationEndpoint).origin
  return {
    authorizationServerUrl: issuer,
    resourceMetadata: { resource, authorization_servers: [issuer] },
    authorizationServerMetadata: {
      issuer,
      authorization_endpoint: endpoints.authorizationEndpoint,
      token_endpoint: endpoints.tokenEndpoint,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    },
  }
}

export function oauthIssuerMismatchMessage(expected: string | undefined, received: string | undefined): string {
  // Metadata is untrusted. Never echo credentials, queries or fragments in diagnostics.
  const display = (value: string | undefined) => {
    if (!value) return "an unspecified address"
    try { const url = new URL(value); return `${url.origin}${url.pathname}` } catch { return "an invalid address" }
  }
  return `This server's sign-in information is inconsistent: it names ${display(expected)} as its sign-in service, but that service identifies itself as ${display(received)}. OpenWork stopped for security. Ask the server owner to fix it, or enter the sign-in addresses manually under Sign-in addresses in the connection settings.`
}
