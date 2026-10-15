import { createNativeConnector, denFetch, type DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, SkipError, type Seed } from "@openwork/env";
import { startMockGoogle } from "@openwork/labs";

export const SHEET = "application/vnd.google-apps.spreadsheet";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected response object");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string response field");
  return value;
}
export function objects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (typeof value !== "object" || value === null) return [];
  const record = object(value);
  return [record, ...Object.values(record).flatMap((entry) => {
    if (typeof entry !== "string") return objects(entry);
    try { return objects(JSON.parse(entry)); } catch { return []; }
  })];
}

/** A stored Excel file larger than one 8 MiB pull chunk, with bytes no text decoder accepts. */
export const supplierWorkbook = (() => {
  const bytes = Buffer.alloc(9 * 1024 * 1024 + 17);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
  bytes.set([0x50, 0x4b, 0x03, 0x04, 0xfe, 0xff], 0);
  return bytes;
})();
export const inventoryExport = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("inventory workbook export: sku,qty widget,17")]);

/** A real Den with one member's Drive in synthetic Google; requests act as that member's host transport. */
export async function driveFileTransfers(seed: Seed) {
  if (process.env.OPENWORK_EVAL_DEN_API_URL) throw new SkipError("owned local Den for loopback Google witnesses");
  if (!await localMysqlIsRunning() || !await localRedisIsRunning()) throw new SkipError("local MySQL and Redis");
  const stack = new AsyncDisposableStack();
  try {
    const accounts = { member: "drive-member@test.example", other: "drive-other@test.example" };
    const files = { supplier: "supplier-xlsx-1", inventory: "inventory-sheet-1", inventoryShortcut: "inventory-shortcut-1", folder: "suppliers-folder-1", quoted: "quoted-filename-1" };
    const google = stack.use(await startMockGoogle({
      accounts: Object.values(accounts), port: 0,
      driveFiles: {
        [accounts.member]: [
          { id: files.supplier, name: "Supplier entry.xlsx", mimeType: XLSX, content: supplierWorkbook, parents: ["suppliers-folder"] },
          { id: files.inventory, name: "Inventory", mimeType: SHEET, parents: ["inventory-folder"], exports: { [XLSX]: inventoryExport, "text/csv": Buffer.from("sku,qty\nwidget,17\n") } },
          { id: files.inventoryShortcut, name: "Inventory", mimeType: "application/vnd.google-apps.shortcut", parents: ["shared-folder"], shortcutTo: files.inventory },
          { id: files.folder, name: "Suppliers", mimeType: "application/vnd.google-apps.folder" },
          { id: files.quoted, name: "x'; touch shell-injected; echo '", mimeType: "text/plain", content: Buffer.from("literal filename download") },
        ],
      },
    }));
    const den = await seed.den({ web: false, org: { name: `Drive files ${Date.now()}`, members: { first: {}, second: {} } }, env: {
      RESEND_API_KEY: "", SMTP_HOST: "",
      DEN_GOOGLE_API_BASE_URL: google.apiUrl, DEN_GOOGLE_OAUTH_AUTHORIZE_URL: google.authorizeUrl,
      DEN_GOOGLE_OAUTH_TOKEN_URL: google.tokenUrl, DEN_GOOGLE_OAUTH_USERINFO_URL: google.userinfoUrl,
    } });
    const first = den.members.first; const second = den.members.second;
    if (!first || !second) throw new Error("Missing seeded members");
    const native = (name: string, features: string[]) => createNativeConnector(den.admin, { providerKey: "google-workspace", name, clientId: `fixture-${name.replaceAll(" ", "-")}`, clientSecret: "synthetic-secret", features });
    const full = await native("Drive Full", ["driveFull"]);
    const readOnly = await native("Drive Read Only", ["driveRead"]);
    async function connect(member: DenSession, id: string, email: string) {
      const start = await denFetch(member, `/v1/mcp-connections/${id}/connect/start`, { headers: { authorization: `Bearer ${member.token}` } });
      if (!start.response.ok) throw new Error(`Google OAuth start HTTP ${start.response.status}`);
      const url = new URL(text(object(start.body).authorizeUrl));
      if (url.origin !== google.apiUrl) throw new Error("Refusing non-witness Google OAuth");
      url.searchParams.set("prompt", "consent select_account");
      const chooser = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      if (chooser.status !== 200) throw new Error("Google witness did not offer account choice");
      await chooser.text(); await google.chooseAccount(email, { timeoutMs: 10_000 });
    }
    await connect(first, full.id, accounts.member);
    await connect(first, readOnly.id, accounts.member);
    await connect(second, full.id, accounts.other);
    async function mint(member: DenSession) {
      const result = await denFetch(member, "/v1/mcp/token", { method: "POST", headers: { authorization: `Bearer ${member.token}` }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
      if (!result.response.ok) throw new Error(`MCP token HTTP ${result.response.status}`);
      return text(object(result.body).token);
    }
    const tokens = { first: await mint(first), second: await mint(second) };

    let rpcId = 0;
    return {
      google, accounts, files, fullId: full.id, readOnlyId: readOnly.id, denUrl: den.ref.apiUrl, memberToken: tokens.first, objects,
      /** Den host transport as a member, with the selected connection. */
      async host(path: string, init: { method?: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown } = {}, identity: "first" | "second" = "first") {
        const url = new URL(`${den.ref.apiUrl}${path}`);
        for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
        const response = await fetch(url, {
          method: init.method ?? "GET",
          headers: { authorization: `Bearer ${tokens[identity]}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
          ...(init.body ? { body: JSON.stringify(init.body) } : {}),
          signal: AbortSignal.timeout(60_000),
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        let json: Record<string, unknown> | null = null;
        if (response.headers.get("content-type")?.includes("application/json")) json = object(JSON.parse(bytes.toString("utf8")));
        return { status: response.status, headers: response.headers, bytes, json };
      },
      /** Cloud MCP gateway as a member. */
      async mcp(name: string, args: Record<string, unknown>) {
        const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, { method: "POST", headers: { authorization: `Bearer ${tokens.first}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
        const raw = await response.text(); const line = raw.split("\n").find((part) => part.startsWith("data:"));
        const envelope = object(JSON.parse(line ? line.slice(5) : raw));
        if (envelope.error) throw new Error("MCP protocol error"); return object(envelope.result);
      },
      /** The bytes a host sends to a Google resumable session; no OpenWork or Google credentials. */
      async put(uploadUrl: string, bytes: Uint8Array, range: string, mimeType = XLSX) {
        if (new URL(uploadUrl).origin !== google.apiUrl) throw new Error("Refusing non-witness file transport");
        return fetch(uploadUrl, { method: "PUT", redirect: "manual", headers: { "content-type": mimeType, "content-range": range }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(60_000) });
      },
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
