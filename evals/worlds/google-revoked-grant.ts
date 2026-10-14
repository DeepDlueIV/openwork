import { createNativeConnector, denFetch } from "@openwork/behaviors";
import { server, type Place } from "@openwork/env";
import { startMockGoogle } from "@openwork/labs";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

/** An isolated Den with one member connected to synthetic Google through the real OAuth callback. */
export async function googleRevokedGrant(place: Place) {
  const email = "revoked@example.test";
  const stack = new AsyncDisposableStack();
  try {
    // Shorter than Den's 60 s safety window, so every Google call renews the token.
    const provider = stack.use(await startMockGoogle({ accounts: [email], port: 0, accessTokenTtlSeconds: 30 }));
    const den = stack.use(await server({
      place, web: false, org: { name: `Revoked Google ${Date.now()}`, members: { member: {} } },
      env: {
        DEN_GOOGLE_OAUTH_AUTHORIZE_URL: provider.authorizeUrl,
        DEN_GOOGLE_OAUTH_TOKEN_URL: provider.tokenUrl,
        DEN_GOOGLE_OAUTH_USERINFO_URL: provider.userinfoUrl,
        DEN_GOOGLE_API_BASE_URL: provider.apiUrl,
      },
    }));
    if (!den.database) throw new Error("Must cold-boot an owned isolated database, never attach a shared Den");
    const member = den.members.member;
    const headers = { authorization: `Bearer ${member.token}` };
    const connection = await createNativeConnector(den.admin, {
      providerKey: "google-workspace", name: "Revoked Google", features: ["gmailRead"],
      clientId: "synthetic-revoked-google", clientSecret: "synthetic-revoked-google-secret",
    });
    const started = await denFetch(member, `/v1/mcp-connections/${connection.id}/connect/start`, { headers });
    if (started.response.status !== 200) throw new Error(`connect/start failed: ${started.text}`);
    const authorize = new URL(String(record(started.body).authorizeUrl));
    authorize.searchParams.set("prompt", "select_account");
    await fetch(authorize, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    await provider.chooseAccount(email, { timeoutMs: 30_000 });

    const call = async (path: string) => {
      const result = await denFetch(member, path, { headers });
      return { status: result.response.status, body: result.body };
    };
    const owned = stack.move();
    return {
      email,
      status: () => call(`/v1/oauth-providers/${connection.id}/status`),
      gmailMessages: () => call("/v1/capabilities/google-workspace/gmail-messages?maxResults=1"),
      revoke: () => provider.revoke(email),
      tokenRequests: async () => (await provider.tokenRequests()).length,
      [Symbol.asyncDispose]: () => owned.disposeAsync(),
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
