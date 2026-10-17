// Credential-free code, written beside the managed loaders. Native require's
// canonical module cache is process-wide, unlike OpenCode's Location-scoped
// ESM/source graphs. The capability itself only ever lives in this closure.
export const providerCredentialBrokerSource = String.raw`
const { createReadStream } = require("node:fs");
const { once } = require("node:events");
const credential = (async () => {
  if (process.env.OPENWORK_PROVIDER_SESSION_FD !== "3") return null;
  delete process.env.OPENWORK_PROVIDER_SESSION_FD;
  const stream = createReadStream("", { fd: 3, autoClose: true });
  try {
    let text = "";
    for await (const chunk of stream) {
      text += String(chunk);
      if (text.length > 8192) throw new Error("Invalid desktop credential channel");
    }
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || typeof value.endpoint !== "string" || typeof value.token !== "string" || !value.token) {
      throw new Error("Invalid desktop credential channel");
    }
    return { endpoint: value.endpoint, token: value.token };
  } finally {
    stream.destroy();
    if (!stream.closed) await once(stream, "close");
  }
})();
module.exports = Object.freeze({
  initialize: async () => { await credential; },
  fetchSession: async (fetcher, endpoint, signal) => {
    const value = await credential;
    if (!value || endpoint !== value.endpoint) return null;
    return fetcher(endpoint, {
      headers: { accept: "application/json", authorization: "Bearer " + value.token },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500),
    });
  },
});
`;
