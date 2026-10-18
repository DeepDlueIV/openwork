import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { connect, debuggerUrlFor, listTargets, type Surface } from "@openwork/cdp";
import { bootDen, field, list, startFakeHttpServer, text, type Den } from "../../ee/apps/den-api/test/api/harness.ts";

/** Real Workbot UI, Den authorization/credentials/callbacks and a disposable MySQL database.
 * Only the outside provider and unrelated chat/runner responses are faked; no credentials leave localhost. */
export async function workbotConnect(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  let den: Den | undefined;
  let token = "";
  let workbotUrl = "";
  let starts = 0;
  let exchanges = 0;
  const provider = await startFakeHttpServer(async (request, body, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/authorize") {
      response.setHeader("content-type", "text/html");
      const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
      const fields = [...url.searchParams].map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join("");
      response.end(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local provider consent</title><body style="font:16px system-ui;padding:32px"><h1>Connect your account</h1><p>Allow OpenWork to read your Drive files.</p><form action="/consent">${fields}<button name="outcome" value="approve">Approve access</button> <button name="outcome" value="deny">Decline access</button> <button name="outcome" value="partial">Grant incomplete access</button> <button name="outcome" value="expired">Use expired consent</button></form></body></html>`);
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
      exchanges++;
      const code = new URLSearchParams(body).get("code");
      response.setHeader("content-type", "application/json");
      if (code === "expired") { response.writeHead(400).end(JSON.stringify({ error: "invalid_grant", error_description: "Authorization expired" })); return; }
      response.end(JSON.stringify({ access_token: "local-fake-access", expires_in: 3600, token_type: "Bearer", scope: code === "partial" ? "openid" : "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/calendar.readonly" }));
      return;
    }
    if (url.pathname === "/userinfo") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ sub: "local-member", email: "member@example.test", name: "Member Example" })); return; }
    if (url.pathname === "/calendar/v3/calendars/primary/events") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ items: [] })); return; }
    if (url.pathname === "/drive/v3/files") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ files: [{ id: "file_brief", name: "Project brief.txt", mimeType: "text/plain", modifiedTime: "2026-10-18T09:00:00Z", size: "12", webViewLink: "https://drive.google.com/file/d/file_brief/view" }] })); return; }
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
        if (url.pathname === "/v1/workbot/me") return json({ name: "Member Example", email: "member@example.test", userId: "fixture-member", organizationId: "fixture-org", organizationName: "Example workspace", enabled: true, calendar: true, documents: true, workspaceAssistant: true, canSchedule: false, sideChats: false, denUrl: provider.url });
        if (url.pathname === "/v1/workbot") return json({ available: true, name: "Workbot", organizationName: "Example workspace", status: "idle", turns: [], hasEarlier: false, filesEnabled: false });
        if (url.pathname === "/v1/workbot/events") { res.setHeader("content-type", "text/event-stream"); res.end(": fixture\n\n"); return; }
        if (url.pathname === "/v1/workbot/connections" || url.pathname.startsWith("/v1/workbot/documents/") || url.pathname.startsWith("/v1/workbot/calendar/") || url.pathname.endsWith("/connect/start")) {
          let body = ""; for await (const chunk of req) body += chunk;
          if (url.pathname.endsWith("/connect/start")) starts++;
          const result = await den.request(token, req.method === "POST" ? "POST" : "GET", url.pathname + url.search, body ? { body: JSON.parse(body) } : {});
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
    const configured = await den.as(owner, orgId)("POST", "/v1/oauth-providers/google-workspace/client", { clientId: "fixture-client", clientSecret: "fixture-secret", features: ["driveRead", "calendarRead"] });
    if (configured.status !== 200) throw new Error(configured.text);
    token = await den.mintMcpToken(owner, orgId);
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-connect", startUrl: `${workbotUrl}documents`, headless: true }));
    const clients: Array<{ close(): void }> = [];
    resources.defer(() => { for (const client of clients) client.close(); });
    return {
      web, url: workbotUrl,
      starts: () => starts, exchanges: () => exchanges,
      async ready() { const result = await currentDen.request(token, "GET", "/v1/workbot/connections"); return list(field(result.body, "connections")).some(connection => connection.ready === true); },
      // Attach only to the real provider window opened by the user's click. No page state is read or written.
      async consent(): Promise<Surface> {
        const targets = await listTargets(web.handle.cdpUrl);
        const target = targets.find(target => target.type === "page" && target.url.startsWith(`${provider.url}/authorize`));
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
