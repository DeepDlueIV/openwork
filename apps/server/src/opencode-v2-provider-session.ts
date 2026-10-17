import { randomBytes, timingSafeEqual } from "node:crypto";
import { serve } from "./serve-node.js";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";

/** A separate, read-only capability: never the host token, and never persisted in engine config. */
export async function createV2ProviderSessionBridge(current: () => CloudProviderDenSession | null) {
  const token = randomBytes(32).toString("base64url");
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    const supplied = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return new Response(null, { status: 401 });
    // This credential handoff is for the child process, never a browser surface.
    if (request.headers.has("origin") || request.method !== "GET" || new URL(request.url).pathname !== "/session") {
      return new Response(null, { status: 404 });
    }
    const session = current();
    return Response.json(session ? { apiBaseUrl: session.baseUrl, token: session.token, orgId: session.orgId } : null,
      { headers: { "Cache-Control": "no-store" } });
  } });
  return { url: `http://127.0.0.1:${server.port}/session`, token, close: () => server.stop() };
}
