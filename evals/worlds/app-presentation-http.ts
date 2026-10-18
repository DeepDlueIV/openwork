import type { AppWeb } from "@openwork/env";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Network-only resource fault. The browser still runs the real host and sandbox. */
export async function appPresentationHttp(app: AppWeb, resolve: () => Promise<unknown>, readChecklist: (checkOnly: boolean) => Promise<unknown>, delayBootstrap: () => boolean) {
  if (!app.client.webSocketDebuggerUrl) throw new Error("App presentation requires browser CDP");
  const socket = new WebSocket(app.client.webSocketDebuggerUrl);
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  let sequence = 0;
  let failure: Error | undefined;
  let disposing = false;
  let bootstrapDelayedDocuments = 0;
  const fail = (cause: unknown) => {
    failure ??= cause instanceof Error ? cause : new Error(String(cause));
    for (const request of pending.values()) request.reject(failure);
  };
  async function command(method: string, params: Record<string, unknown> = {}) {
    if (failure) throw failure;
    const id = ++sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`App presentation CDP timeout: ${method}`)), 15_000);
        socket.send(JSON.stringify({ id, method, params }));
      });
    } finally { clearTimeout(timer); pending.delete(id); }
  }
  async function paused(params: Record<string, unknown>) {
    if (typeof params.requestId !== "string" || !record(params.request)) throw new Error("Malformed resource request");
    const requestId = params.requestId;
    if (params.request.method === "OPTIONS") return command("Fetch.continueRequest", { requestId });
    if (typeof params.request.url === "string" && new URL(params.request.url).pathname.endsWith("/mcp-apps/sandbox.html")) {
      if (!delayBootstrap()) return command("Fetch.continueRequest", { requestId });
      // Network fault on the shipping proxy, not invented renderer state/logs:
      // defer only launch notifications so the real pre-result render is witnessed.
      const original = await fetch(params.request.url, { signal: AbortSignal.timeout(10_000) });
      const html = await original.text();
      const relay = 'inner.contentWindow?.postMessage(event.data, "*");';
      const declaration = 'let resourceAssigned = false;';
      const report = 'window.parent.postMessage(event.data, hostTargetOrigin);';
      if (!original.ok || ![relay, declaration, report].every(part => html.includes(part))) throw new Error("The shipping sandbox relay did not match the bootstrap fixture");
      // Hold real launch messages until the real generated runtime has reported
      // a pre-result render error. A fixed delay cannot prove that risky state.
      const delayed = html.replace(declaration, `${declaration} let heldLaunch = []; let bootstrapSeen = false;`)
        .replace(relay, `if (!bootstrapSeen && (event.data?.method === "ui/notifications/tool-input" || event.data?.method === "ui/notifications/tool-result")) {
          heldLaunch.push(event.data);
        } else { ${relay} }`)
        .replace(report, `if (event.data?.method === "notifications/message" && event.data.params?.logger === "generated-mcp-app"
          && event.data.params?.data?.hasLaunchResult === false) {
          bootstrapSeen = true;
          ${report}
          for (const message of heldLaunch) inner.contentWindow?.postMessage(message, "*");
          heldLaunch = [];
          return;
        }
        ${report}`);
      bootstrapDelayedDocuments++;
      return command("Fetch.fulfillRequest", { requestId, responseCode: original.status,
        responseHeaders: Array.from(original.headers).filter(([name]) => !["content-length", "content-encoding", "transfer-encoding"].includes(name)).map(([name, value]) => ({ name, value })),
        body: Buffer.from(delayed).toString("base64") });
    }
    const isRead = typeof params.request.url === "string" && new URL(params.request.url).pathname.endsWith("/mcp-apps/call");
    let checkOnly = false;
    if (isRead) {
      const input: unknown = typeof params.request.postData === "string" ? JSON.parse(params.request.postData) : null;
      if (!record(input) || input.name !== "read_checklist" || input.approved === true) {
        throw new Error("The checklist fixture only accepts its declared background read or authority recheck");
      }
      checkOnly = input.checkOnly === true;
    }
    const body = await (isRead ? readChecklist(checkOnly) : resolve());
    await command("Fetch.fulfillRequest", {
      requestId, responseCode: record(body) && body.code === "mcp_access_denied" ? 403
        : record(body) && body.code === "mcp_auth_required" ? 401 : 200,
      responseHeaders: [
        { name: "Content-Type", value: "application/json" },
        { name: "Access-Control-Allow-Origin", value: new URL(app.webUrl).origin },
        { name: "Access-Control-Allow-Credentials", value: "true" },
        { name: "Cache-Control", value: "no-store" },
      ],
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
    });
  }
  socket.addEventListener("message", ({ data }) => {
    try {
      const message: unknown = JSON.parse(String(data));
      if (!record(message)) return;
      if (typeof message.id === "number") {
        if (message.error) pending.get(message.id)?.reject(new Error(JSON.stringify(message.error)));
        else pending.get(message.id)?.resolve();
      }
      if (message.method === "Fetch.requestPaused" && record(message.params)) void paused(message.params).catch(fail);
    } catch (error) { fail(error); }
  });
  socket.addEventListener("error", () => fail(new Error("App presentation CDP disconnected")));
  socket.addEventListener("close", () => { if (!disposing) fail(new Error("App presentation CDP closed")); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("App presentation CDP connection timed out")), 15_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("App presentation CDP connection failed")); }, { once: true });
  });
  await command("Fetch.enable", { patterns: ["*/mcp-apps/resolve", "*/mcp-apps/call", "*/mcp-apps/sandbox.html*"].map(urlPattern => ({ urlPattern, requestStage: "Request" })) });
  return {
    check() { if (failure) throw failure; },
    bootstrapDelayedDocuments() { if (failure) throw failure; return bootstrapDelayedDocuments; },
    async [Symbol.asyncDispose]() {
      try { if (socket.readyState === WebSocket.OPEN) await command("Fetch.disable"); }
      finally { disposing = true; socket.close(); }
    },
  };
}
