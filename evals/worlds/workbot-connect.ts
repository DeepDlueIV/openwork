import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { connect, debuggerUrlFor, listTargets, type Surface } from "@openwork/cdp";
import { bootDen, field, list, startFakeHttpServer, text, type Den } from "../../ee/apps/den-api/test/api/harness.ts";

/** Real Workbot UI, Den authorization/credentials/callbacks and a disposable MySQL database.
 * Only the outside provider and unrelated chat/runner responses are faked; no credentials leave localhost. */
export async function workbotConnect(_seed: Seed, { place }: { place: Place }, options: { draftRecovery?: boolean } = {}) {
  const resources = new AsyncDisposableStack();
  let den: Den | undefined;
  let token = "";
  let workbotUrl = "";
  let starts = 0;
  let exchanges = 0;
  let latestAuthorizationState: string | null = null;
  let authorizationRevoked = false;
  let fileDenied = false;
  let useOtherIdentity = false;
  let otherToken = "";
  let identityReads = 0;
  let refreshFailures = 0;
  let providerFileDenials = 0;
  const editorReads: Array<{ status: number; fileId: string }> = [];
  const directoryReads: number[] = [];
  const documentWrites: string[] = [];
  const savedText = "Saved project overview.\n";
  const grantedScope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/calendar.readonly" + (options.draftRecovery ? " https://www.googleapis.com/auth/drive" : "");
  const provider = await startFakeHttpServer(async (request, body, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/authorize") {
      response.setHeader("content-type", "text/html");
      const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
      const fields = [...url.searchParams].map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join("");
      const standalone = new URL(url.pathname + url.search, provider.url);
      standalone.searchParams.set("presentation", "standalone");
      // Real browser navigation with noopener models a provider that severs the opener. The callback itself is not mocked.
      response.end(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local provider consent</title><body style="font:16px system-ui;padding:32px"><h1>Connect your account</h1><p>Allow OpenWork to read your Drive files.</p><form action="/consent">${fields}<button name="outcome" value="approve">Approve access</button> <button name="outcome" value="deny">Decline access</button> <button name="outcome" value="partial">Grant incomplete access</button> <button name="outcome" value="expired">Use expired consent</button></form><p><a href="${escape(standalone.toString())}" target="_blank" rel="noopener">Continue in a separate tab</a></p></body></html>`);
      return;
    }
    if (url.pathname === "/consent") {
      const target = new URL(text(url.searchParams.get("redirect_uri"), "callback"));
      if (target.origin !== provider.url) throw new Error("Fixture callback left localhost");
      target.searchParams.set("state", text(url.searchParams.get("state"), "state"));
      if (url.searchParams.get("outcome") === "deny") target.searchParams.set("error", "access_denied");
      else target.searchParams.set("code", url.searchParams.get("outcome") ?? "approve");
      response.writeHead(302, { location: target.toString() }).end();
      return;
    }
    if (url.pathname === "/token") {
      const request = new URLSearchParams(body);
      const refresh = request.get("grant_type") === "refresh_token";
      if (!refresh) exchanges++;
      const code = request.get("code");
      response.setHeader("content-type", "application/json");
      if (code === "expired" || refresh && authorizationRevoked) {
        if (refresh) refreshFailures++;
        response.writeHead(400).end(JSON.stringify({ error: "invalid_grant", error_description: "Authorization expired" })); return;
      }
      if (!refresh) authorizationRevoked = false;
      response.end(JSON.stringify({ access_token: "local-fake-access", expires_in: options.draftRecovery ? 30 : 3600, ...(options.draftRecovery ? { refresh_token: "local-fake-refresh" } : {}), token_type: "Bearer", scope: code === "partial" ? "openid" : grantedScope }));
      return;
    }
    // External provider/session faults are driven through a real separate browser, never renderer state setters.
    if (options.draftRecovery && url.pathname.startsWith("/account")) {
      if (request.method === "POST") {
        const action = new URLSearchParams(body).get("action");
        if (action === "expire") authorizationRevoked = true;
        if (action === "deny-file") fileDenied = true;
        if (action === "allow-file") fileDenied = false;
        if (action === "other-identity") useOtherIdentity = true;
        if (action === "original-identity") useOtherIdentity = false;
      }
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><html><title>Local account controls</title><body><h1>Local account controls</h1><form method="post" action="/account"><button name="action" value="expire">Expire account authorization</button><button name="action" value="deny-file">Deny file access</button><button name="action" value="allow-file">Allow file access</button><button name="action" value="other-identity">Use another signed-in member</button><button name="action" value="original-identity">Restore original member</button></form><p role="status">Authorization ${authorizationRevoked ? "expired" : "active"}; file ${fileDenied ? "denied" : "allowed"}; member ${useOtherIdentity ? "other" : "original"}</p></body></html>`);
      return;
    }
    if (url.pathname === "/userinfo") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ sub: "local-member", email: "member@example.test", name: "Member Example" })); return; }
    if (url.pathname === "/calendar/v3/calendars/primary/events") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ items: [] })); return; }
    if (url.pathname.startsWith("/drive/") || url.pathname.startsWith("/upload/drive/")) {
      if (request.method !== "GET") { documentWrites.push(`provider:${request.method}:${url.pathname}`); response.writeHead(400).end("Unexpected document write"); return; }
      if (authorizationRevoked) { response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Authorization expired", errors: [{ reason: "authError" }] } })); return; }
      if (url.pathname === "/drive/v3/files/file_brief") {
        if (fileDenied) { providerFileDenials++; response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "File access denied", errors: [{ reason: "forbidden" }] } })); return; }
        if (url.searchParams.get("alt") === "media") { response.setHeader("content-type", "text/plain"); response.end(savedText); return; }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: "file_brief", name: "Project brief.txt", mimeType: "text/plain", version: "1", headRevisionId: "revision_one", capabilities: { canEdit: true }, size: String(savedText.length), modifiedTime: "2026-10-18T09:00:00Z" })); return;
      }
      if (url.pathname === "/drive/v3/files") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ files: [{ id: "file_brief", name: "Project brief.txt", mimeType: "text/plain", modifiedTime: "2026-10-18T09:00:00Z", size: String(savedText.length), webViewLink: "https://drive.google.com/file/d/file_brief/view" }] })); return; }
    }
    if (url.pathname.startsWith("/v1/oauth-providers/") && den) {
      const result = await den.request(null, "GET", url.pathname + url.search);
      response.writeHead(result.status, { "content-type": result.headers.get("content-type") ?? "text/html" }).end(result.text);
      return;
    }
    response.writeHead(404).end();
  });
  resources.defer(() => provider.close());
  try {
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)), server: { host: "127.0.0.1", port: 0, strictPort: false }, plugins: [{ name: "workbot-connect-local-provider", configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://fixture");
        if (!url.pathname.startsWith("/v1/workbot")) return next();
        const json = (body: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
        if (!den) return json({ error: "not_ready" }, 503);
        if (url.pathname === "/v1/workbot/me") {
          if (!options.draftRecovery) return json({ name: "Member Example", email: "member@example.test", userId: "fixture-member", organizationId: "fixture-org", organizationName: "Example workspace", enabled: true, calendar: true, documents: true, workspaceAssistant: true, canSchedule: false, sideChats: false, denUrl: provider.url });
          identityReads++;
          const session = await den.request(useOtherIdentity ? otherToken : token, "GET", "/v1/workbot/session");
          if (session.status !== 200) return json(session.body, session.status);
          return json({ name: field(session.body, "user", "name"), email: field(session.body, "user", "email"), userId: field(session.body, "user", "id"), organizationId: field(session.body, "organization", "id"), organizationName: field(session.body, "organization", "name"), enabled: true, calendar: true, documents: true, workspaceAssistant: true, canSchedule: false, sideChats: false, denUrl: provider.url });
        }
        if (url.pathname === "/v1/workbot") return json({ available: true, name: "Workbot", organizationName: "Example workspace", status: "idle", turns: [], hasEarlier: false, filesEnabled: false });
        if (url.pathname === "/v1/workbot/events") { res.setHeader("content-type", "text/event-stream"); res.end(": fixture\n\n"); return; }
        if (url.pathname === "/v1/workbot/connections" || url.pathname.startsWith("/v1/workbot/documents/") || url.pathname.startsWith("/v1/workbot/calendar/") || url.pathname.endsWith("/connect/start")) {
          let body = ""; for await (const chunk of req) body += chunk;
          if (url.pathname.endsWith("/connect/start")) starts++;
          if (req.method === "POST" && url.pathname.startsWith("/v1/workbot/documents/")) documentWrites.push(`workbot:${url.pathname}`);
          const result = await den.request(useOtherIdentity ? otherToken : token, req.method === "POST" ? "POST" : "GET", url.pathname + url.search, body ? { body: JSON.parse(body) } : {});
          if (url.pathname.endsWith("/drive-files")) directoryReads.push(result.status);
          const openedFile = /\/files\/([^/]+)\/editor$/.exec(url.pathname);
          if (req.method === "GET" && openedFile?.[1]) editorReads.push({ fileId: openedFile[1], status: result.status });
          // Older Den responses omit provider identity hints; that is unverified, not proof a grant is absent.
          const referring = new URL(req.headers.referer ?? workbotUrl);
          if (url.pathname === "/v1/workbot/connections" && referring.searchParams.get("catalog") === "legacy") {
            return json({ connections: list(field(result.body, "connections")).map(connection => ({ id: connection.id, name: connection.name, app: connection.app, ready: connection.ready, connectUrl: connection.connectUrl })) }, result.status);
          }
          if (url.pathname.endsWith("/connect/start")) {
            const authorizeUrl = field(result.body, "authorizeUrl");
            latestAuthorizationState = typeof authorizeUrl === "string" ? new URL(authorizeUrl).searchParams.get("state") : null;
          }
          res.writeHead(result.status, { "content-type": "application/json" }).end(result.text);
          return;
        }
        return json({ error: "not_found" }, 404);
      });
    } }] });
    resources.defer(() => vite.close());
    await vite.listen();
    workbotUrl = text(vite.resolvedUrls?.local[0], "Workbot URL");
    den = await bootDen({ env: { DEN_WORKBOT_URL: workbotUrl, DEN_API_PUBLIC_URL: provider.url, DEN_GOOGLE_API_BASE_URL: provider.url, DEN_GOOGLE_OAUTH_AUTHORIZE_URL: `${provider.url}/authorize`, DEN_GOOGLE_OAUTH_TOKEN_URL: `${provider.url}/token`, DEN_GOOGLE_OAUTH_USERINFO_URL: `${provider.url}/userinfo` } });
    const currentDen = den;
    resources.defer(() => currentDen.close());
    const { owner, orgId } = await den.createOrg(await den.signUp("Member Example"), "Example workspace");
    await den.setFeature(orgId, "workbot", true);
    await den.setFeature(orgId, "workbotDocuments", true);
    await den.setFeature(orgId, "workbotInlineConnect", true);
    const configured = await den.as(owner, orgId)("POST", "/v1/oauth-providers/google-workspace/client", { clientId: "fixture-client", clientSecret: "fixture-secret", features: options.draftRecovery ? ["driveRead", "driveFull", "calendarRead"] : ["driveRead", "calendarRead"] });
    if (configured.status !== 200) throw new Error(configured.text);
    token = await den.mintMcpToken(owner, orgId);
    if (options.draftRecovery) {
      const other = await den.newMember(owner, orgId, "Other Member");
      otherToken = await den.mintMcpToken(other, orgId);
      // This second real Den member also has file access, but may never reveal the first member's retained draft.
      const started = await den.as(other, orgId)("GET", "/v1/oauth-providers/google-workspace/connect/start");
      if (started.status !== 200) throw new Error(started.text);
      const authorize = new URL(text(field(started.body, "authorizeUrl"), "seed authorization"));
      const callback = new URL(text(authorize.searchParams.get("redirect_uri"), "seed callback"));
      callback.searchParams.set("state", text(authorize.searchParams.get("state"), "seed state"));
      callback.searchParams.set("code", "approve");
      const connected = await den.request(null, "GET", callback.pathname + callback.search);
      if (connected.status !== 200) throw new Error(connected.text);
    }
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-connect", startUrl: `${workbotUrl}documents`, headless: true }));
    const accountWeb = options.draftRecovery ? resources.use(await chrome({ host: place.host(), name: "local-provider-account", startUrl: `${provider.url}/account`, headless: true })) : undefined;
    const clients: Array<{ close(): void }> = [];
    resources.defer(() => { for (const client of clients) client.close(); });
    return {
      web, url: workbotUrl, accountWeb,
      starts: () => starts, exchanges: () => exchanges,
      documentWrites: () => [...documentWrites], editorReads: () => [...editorReads], directoryReads: () => [...directoryReads], identityReads: () => identityReads, refreshFailures: () => refreshFailures, providerFileDenials: () => providerFileDenials,
      async otherMemberCanRead() { return (await currentDen.request(otherToken, "GET", "/v1/workbot/documents/v1/documents/google-drive/files/file_brief/editor")).status === 200; },
      async ready() { const result = await currentDen.request(token, "GET", "/v1/workbot/connections"); return list(field(result.body, "connections")).some(connection => connection.ready === true); },
      // Attach only to the real provider window opened by the user's click. No page state is read or written.
      async consent(standalone = false): Promise<Surface> {
        const targets = await listTargets(web.handle.cdpUrl);
        const target = targets.find(target => target.type === "page" && target.url.startsWith(`${provider.url}/authorize`) && new URL(target.url).searchParams.get("state") === latestAuthorizationState && (new URL(target.url).searchParams.get("presentation") === "standalone") === standalone);
        if (!target) throw new Error("The provider consent window did not open");
        const client = await connect(debuggerUrlFor(web.handle.cdpUrl, target));
        await client.send("Page.enable");
        clients.push(client);
        return { handle: { ...web.handle, name: "local-provider-consent" }, client };
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}

export async function workbotDraftConnect(seed: Seed, context: { place: Place }) {
  const world = await workbotConnect(seed, context, { draftRecovery: true });
  if (!world.accountWeb) { await world[Symbol.asyncDispose](); throw new Error("Provider account controls did not start"); }
  return { ...world, accountWeb: world.accountWeb };
}
