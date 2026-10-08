import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { startMockGoogle, type MockTokenScopes } from "@openwork/labs";
import { needs, server, test } from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}

const EMAIL = "member@example.test";
// Six permissions on, as on the customer's "What your AI can do".
const FEATURES = ["mailRead", "mailDraft", "mailSend", "calendarRead", "filesRead", "teamsChatRead"];

// Microsoft Entra ID honors offline_access (it issues a refresh token) but never
// lists it in the token response `scope`, and issues a token without any
// permission the tenant has not consented to. A member signing in to the
// org-wide Microsoft 365 connector through the real callback must end connected
// when everything was granted, and must be told what is missing otherwise.
async function microsoft365World(context: { place: Parameters<typeof server>[0]["place"] }, tokenScopes: MockTokenScopes) {
  needs({ commands: ["pnpm"], placement: "local" });
  const provider = await startMockGoogle({ accounts: [EMAIL], port: 0, tokenScopes });
  const den = await server({
    place: context.place, web: false, org: { name: `M365 Entra ${Date.now()}`, members: { member: {} } },
    env: {
      DEN_MICROSOFT_OAUTH_AUTHORIZE_URL: `${provider.authorizeUrl}?tenantId={tenantId}`,
      DEN_MICROSOFT_OAUTH_TOKEN_URL: `${provider.tokenUrl}?tenantId={tenantId}`,
      DEN_MICROSOFT_GRAPH_BASE_URL: `${provider.apiUrl}/v1.0`,
    },
  });
  const member = den.members.member;
  const auth = { authorization: `Bearer ${member.token}` };

  // The org-wide legacy alias, saved the way the Microsoft 365 setup page saves it.
  const configured = await denFetch(den.admin, "/v1/oauth-providers/microsoft-365/client", {
    method: "POST", headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ features: FEATURES, clientId: "synthetic-m365", clientSecret: "synthetic-m365-secret", tenantId: "12345678-1234-1234-1234-123456789abc" }),
  });
  expect(configured.response.status, configured.text).toBe(200);

  async function signIn() {
    const started = await denFetch(member, "/v1/mcp-connections/microsoft-365/connect/start", { headers: auth });
    expect(started.response.status, started.text).toBe(200);
    const authorize = new URL(text(record(started.body).authorizeUrl));
    expect((authorize.searchParams.get("scope") ?? "").split(" "), "Den asks Entra for a refresh token").toContain("offline_access");
    authorize.searchParams.set("prompt", "select_account");
    const chooser = await fetch(authorize, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    expect(chooser.status).toBe(200);
    const page = await provider.chooseAccount(EMAIL, { timeoutMs: 30_000 });
    const status = await denFetch(member, "/v1/oauth-providers/microsoft-365/status", { headers: auth });
    expect(status.response.status, status.text).toBe(200);
    expect(status.body, "the callback stored the grant").toMatchObject({ connected: true, externalAccountId: EMAIL });
    const scopes = record(status.body).scopes;
    expect(scopes, "stored scopes are what Entra reported").not.toContain("offline_access");
    const usable = await denFetch(member, "/v1/mcp-connections?scope=usable", { headers: auth });
    expect(usable.response.status, usable.text).toBe(200);
    const connections = record(usable.body).connections;
    if (!Array.isArray(connections)) throw new Error("Expected connections");
    const entry = connections.map(record).find((connection) => connection.id === "microsoft-365");
    if (!entry) throw new Error(`microsoft-365 is missing from the usable list: ${usable.text.slice(0, 500)}`);
    const observed = `page=${page.status} connectedForMe=${String(entry.connectedForMe)} needsReconnect=${String(entry.needsReconnect)} missingFeatures=${JSON.stringify(entry.missingFeatures)} storedScopes=${JSON.stringify(scopes)}`;
    return { page, entry, observed };
  }

  return {
    signIn,
    apiLog: () => den.apiLog(),
    async [Symbol.asyncDispose]() {
      await den[Symbol.asyncDispose]();
      await provider[Symbol.asyncDispose]();
    },
  };
}

test("Microsoft 365 sign-in with Entra-shaped token scopes ends connected, and re-consent stays connected", { timeout: 240_000 }, async ({ place, evidence }) => {
  await using world = await microsoft365World({ place }, "entra");
  for (const attempt of ["first sign-in", "re-consent"]) {
    const { page, entry, observed } = await world.signIn();
    const ready = page.status === 200 && page.html.includes("You're connected") && entry.connectedForMe === true && entry.needsReconnect === false;
    evidence.recordAssertionEvidence(`Microsoft 365 ${attempt} with Entra-shaped token scopes leaves the member connected`, observed, ready);
    expect(page.html, `${attempt}: callback page (${observed})`).toContain("You're connected");
    expect(entry, `${attempt}: the member is connected and not asked to reconnect (${observed})`).toMatchObject({
      connectedForMe: true,
      needsReconnect: false,
      missingFeatures: [],
    });
  }
});

test("Microsoft 365 sign-in that Entra grants without a required permission names it on the callback page and in the log", { timeout: 240_000 }, async ({ place, evidence }) => {
  await using world = await microsoft365World({ place }, { mode: "entra", withhold: ["Mail.Send"] });
  const { page, entry, observed } = await world.signIn();
  const log = await world.apiLog();
  // console.warn may wrap the structured fields across lines; read the entry that follows the event name.
  const at = log.indexOf("native_oauth_connect_callback_scopes_incomplete");
  const logged = at >= 0 && log.slice(at, at + 1_000).includes("Mail.Send");
  const honest = !page.html.includes("You're connected") && page.html.includes("did not grant: Mail.Send");
  evidence.recordAssertionEvidence("A withheld Microsoft 365 permission is named on the callback page and logged, and the member is asked to reconnect for it", `${observed} pageNamesMissing=${String(honest)} logged=${String(logged)}`, honest && logged && entry.needsReconnect === true);
  expect(page.html, `callback page must not claim success (${observed})`).not.toContain("You're connected");
  expect(page.html).toContain("did not grant: Mail.Send");
  expect(logged, "den-api logs which scope the stored grant lacks").toBe(true);
  expect(entry, observed).toMatchObject({ connectedForMe: true, needsReconnect: true, missingFeatures: ["mailSend"] });
});
