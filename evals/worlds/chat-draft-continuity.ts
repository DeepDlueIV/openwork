import { evalIn } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";

declare global {
  interface Window {
    __draftFeedbackMetrics?: {
      started: number;
      samples: { ms: number; observed: boolean }[];
    };
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export async function chatDraftContinuity(seed: Seed) {
  const workspacePath = seed.tmpPath("chat-draft-continuity");
  const app = await seed.appWeb({ name: "chat-draft-continuity", workspacePath, mouse: true });
  const workspace = await seed.workspace(app, workspacePath);
  const first = await seed.session(app, { title: "First draft conversation" });
  const second = await seed.session(app, { title: "Second draft conversation" });

  // Observe actual request metadata across reload, without retaining credentials,
  // headers, bodies or query strings. CdpClient does not expose protocol events.
  if (!app.client.webSocketDebuggerUrl) throw new Error("The submission witness needs the page debugger URL");
  const socket = new WebSocket(app.client.webSocketDebuggerUrl);
  const submissions: string[] = [];
  let connected = false;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Submission observation did not attach")), 10_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Network.enable" })));
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Submission observation failed")); });
    socket.addEventListener("close", () => { connected = false; });
    socket.addEventListener("message", (event) => {
      const message: unknown = JSON.parse(String(event.data));
      if (!record(message)) return;
      if (message.id === 1) {
        clearTimeout(timer);
        if (message.error) reject(new Error("Submission observation was rejected"));
        else { connected = true; resolve(); }
      }
      const params = message.params;
      if (message.method !== "Network.requestWillBeSent" || !record(params) || !record(params.request)) return;
      const request = params.request;
      if (request.method !== "POST" || typeof request.url !== "string") return;
      const path = new URL(request.url).pathname;
      if (/\/session\/[^/]+\/(prompt(?:_async)?|message|command|shell)$/.test(path)) submissions.push(path);
    });
  }).catch((error: unknown) => { socket.close(); throw error; });

  // Measurement only: observe trusted beforeinput (including Lexical-handled
  // insertions), then the first frame callback that sees the expected text.
  // No application state, response, clock or product control is changed.
  await seed.evalIn(app, () => {
    window.__draftFeedbackMetrics = { started: 0, samples: [] };
    document.addEventListener("beforeinput", (event) => {
      if (!event.isTrusted || !(event instanceof InputEvent) || typeof event.data !== "string"
        || event.inputType !== "insertText" || !(event.target instanceof HTMLElement)) return;
      const editor = event.target.closest('[data-lexical-editor="true"][contenteditable="true"]');
      const metrics = window.__draftFeedbackMetrics;
      if (!editor || !metrics) return;
      metrics.started += 1;
      const expected = (editor.textContent ?? "") + event.data;
      const started = performance.now();
      const observe = () => {
        const observed = (editor.textContent ?? "").startsWith(expected);
        const ms = performance.now() - started;
        if (observed || ms >= 1_000) metrics.samples.push({ ms, observed });
        else requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
    }, { capture: true });
  }).catch((error: unknown) => { socket.close(); throw error; });

  return {
    app, workspace, first, second,
    feedback: () => evalIn(app, () => ({
      started: window.__draftFeedbackMetrics?.started ?? 0,
      samples: window.__draftFeedbackMetrics?.samples ?? [],
      viewport: { width: innerWidth, height: innerHeight },
      phase: "trusted beforeinput to first frame callback observing the expected text",
    })),
    documentGeneration: () => evalIn(app, () => performance.timeOrigin),
    submissionWitness: () => ({ connected, submissions: [...submissions] }),
    async [Symbol.asyncDispose]() { socket.close(); },
  };
}
