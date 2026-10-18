import type { AppWeb } from "@openwork/env";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Network-only resource fault. The browser still runs the real host and sandbox. */
export async function appPresentationHttp(app: AppWeb, resolve: () => Promise<unknown>) {
  if (!app.client.webSocketDebuggerUrl) throw new Error("App presentation requires browser CDP");
  const socket = new WebSocket(app.client.webSocketDebuggerUrl);
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  let sequence = 0;
  let failure: Error | undefined;
  let disposing = false;
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
    const body = await resolve();
    await command("Fetch.fulfillRequest", {
      requestId, responseCode: 200,
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
  await command("Fetch.enable", { patterns: [{ urlPattern: "*/mcp-apps/resolve", requestStage: "Request" }] });
  return {
    check() { if (failure) throw failure; },
    async [Symbol.asyncDispose]() {
      try { if (socket.readyState === WebSocket.OPEN) await command("Fetch.disable"); }
      finally { disposing = true; socket.close(); }
    },
  };
}
