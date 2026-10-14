import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SkipError, type Seed } from "@openwork/env";
import { catalogModelVariants, CLOUD_MODEL_CONFIG_VERSION } from "@openwork/types/cloud-model-fast";
import { buildCloudProviderConfig, isCloudProviderOutOfSync } from "../../apps/app/src/react-app/domains/connections/provider-auth/cloud-provider-config";
import versions from "../../constants.json";
import { engineBinary, stopChild } from "./openwork-server-cli.ts";

const exec = promisify(execFile);
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const modelID = "gemini-3.8-flash";
const catalog = { family: "gemini-flash", reasoning: true, tool_call: true,
  limit: { context: 1_048_576, output: 8192 },
  reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }] };
export const messages = ["Thinking level MINIMAL is not supported for this model", "Thinking level is unsupported: THINKING_LEVEL_MINIMAL"];

function cloudProvider(baseURL: string, apiKey: string): Parameters<typeof buildCloudProviderConfig>[0] {
  return { id: "lpr_google_witness", providerId: "google", source: "custom", name: "Google witness",
    providerConfig: { npm: "@ai-sdk/google", options: { baseURL, apiKey } },
    hasApiKey: true, apiKey: "fixture-only", apiKeys: null, createdAt: null, updatedAt: null,
    models: [{ id: modelID, name: modelID, config: catalog, createdAt: null }] };
}

/** Pure-function controls, kept out of the journey's product imports. */
export function catalogCases() {
  const provider = cloudProvider("http://127.0.0.1", "fixture-only");
  const imported = { cloudProviderId: provider.id, name: provider.name, providerId: provider.id,
    sourceProviderId: provider.providerId, source: provider.source, updatedAt: null,
    modelIds: [modelID], importedAt: 1, modelConfigVersion: CLOUD_MODEL_CONFIG_VERSION - 1 };
  return {
    sdks: ["@ai-sdk/google", "@ai-sdk/google-vertex"].map(npm => ({
      result: catalogModelVariants(catalog, npm),
      overrides: catalogModelVariants({ ...catalog, variants: { low: { disabled: true }, minimal: { custom: true } } }, npm),
      absent: catalogModelVariants({ ...catalog, reasoning_options: [] }, npm),
      disabled: catalogModelVariants({ ...catalog, reasoning: false }, npm),
      mismatch: catalogModelVariants({ ...catalog, provider: { npm: "@ai-sdk/anthropic" } }, npm),
    })),
    bedrock: catalogModelVariants(catalog, "@ai-sdk/amazon-bedrock"),
    materialized: buildCloudProviderConfig(provider).models?.[modelID],
    oldImport: isCloudProviderOutOfSync(provider, imported),
    currentImport: isCloudProviderOutOfSync(provider, { ...imported, modelConfigVersion: CLOUD_MODEL_CONFIG_VERSION }),
  };
}

export async function geminiTitleThinking(_seed: Seed) {
  const binary = process.env.OPENWORK_GEMINI_ENGINE_BIN ?? engineBinary();
  if (!binary) throw new SkipError("install the pinned v1 sidecar or set OPENWORK_GEMINI_ENGINE_BIN");
  const version = (await exec(binary, ["--version"])).stdout.trim();
  if (version !== versions.opencodeVersion.replace(/^v/, "")) throw new Error("Unexpected isolated engine version");
  const baseline = process.env.OPENWORK_GEMINI_BASELINE === "1";
  const live = process.env.OPENWORK_GEMINI_LIVE === "1";
  const project = process.env.OPENWORK_GEMINI_VERTEX_PROJECT;
  if (live && !project) throw new Error("Explicit Vertex project required for tiny live calls");
  // Fail before any inference when ADC is missing; never substitute a mock.
  if (live) await exec("gcloud", ["auth", "application-default", "print-access-token"], { timeout: 30_000 })
    .catch(() => { throw new Error("LIVE NotRun: Application Default Credentials unavailable"); });
  const requests: { title: boolean; level: unknown; status: number; model: string; wording?: string }[] = [];
  const errors: string[] = [];
  const runKey = randomBytes(32).toString("hex");
  let liveCalls = 0;
  let wording = messages[0];
  const witness = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
      // Check the unguessable per-run fixture credential before parsing or ADC.
      // It is not a Google credential and is never recorded in evidence.
      if (request.headers["x-goog-api-key"] !== runKey) {
        response.writeHead(401, { "content-type": "application/json" }).end("{}");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: unknown = JSON.parse(raw);
      if (!record(body)) throw new Error("Expected Google request");
      const title = raw.includes("Generate a title for this conversation");
      const level = record(body.generationConfig) && record(body.generationConfig.thinkingConfig)
        ? body.generationConfig.thinkingConfig.thinkingLevel : undefined;
      const streaming = request.url === `/models/${modelID}:streamGenerateContent?alt=sse`;
      if (!streaming && request.url !== `/models/${modelID}:generateContent`) throw new Error("Provider identity changed");
      const requestedModel = modelID;
      if (live) {
        if (liveCalls >= 2) { response.writeHead(429, { "content-type": "application/json" }).end("{}"); return; }
        liveCalls += 1;
        // ADC token exists only in process memory, never config, args or evidence.
        const { stdout } = await exec("gcloud", ["auth", "application-default", "print-access-token"], { timeout: 30_000 });
        if (!project) throw new Error("Missing selected Vertex project");
        const operation = streaming ? "streamGenerateContent?alt=sse" : "generateContent";
        // Never forward the inbound URL. The destination host, model and two
        // allowed operations are fixed; the operator's project is one segment.
        const destination = new URL(`/v1/projects/${encodeURIComponent(project)}/locations/global/publishers/google/models/${modelID}:${operation}`, "https://aiplatform.googleapis.com");
        const upstream = await fetch(destination, {
          method: "POST", headers: { authorization: `Bearer ${stdout.trim()}`, "content-type": "application/json" },
          body: raw, signal: AbortSignal.timeout(60_000),
        });
        requests.push({ title, level, status: upstream.status, model: requestedModel });
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        response.end(await upstream.text());
        return;
      }
      const rejected = level === "minimal";
      requests.push({ title, level, status: rejected ? 400 : 200, model: requestedModel, ...(rejected ? { wording } : {}) });
      if (rejected) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: wording } }));
        return;
      }
      const data = { candidates: [{ index: 0, content: { role: "model", parts: [{ text: title ? "Kites in a meadow" : "A kite catches the breeze." }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
      if (streaming) response.writeHead(200, { "content-type": "text/event-stream" }).end(`data: ${JSON.stringify(data)}\n\n`);
      else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
    })().catch(() => {
      errors.push("witness failed (details withheld)");
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: errors.at(-1) } }));
    });
  });
  await new Promise<void>(resolve => witness.listen(0, "127.0.0.1", resolve));
  const address = witness.address();
  if (!address || typeof address === "string") throw new Error("Witness did not bind");
  const root = await mkdtemp(join(tmpdir(), "gemini-title-thinking-"));
  const home = join(root, "home");
  const directory = join(root, "workspace");
  await Promise.all([home, directory].map(path => mkdir(path, { recursive: true })));
  const config = join(root, "opencode.json");
  const provider = buildCloudProviderConfig(cloudProvider(`http://127.0.0.1:${address.port}`, runKey));
  // Mirrors cloud-provider-sync: family retained; reasoning_options dropped.
  if (baseline) for (const model of Object.values(provider.models ?? {})) delete model.variants;
  const aliasProvider = buildCloudProviderConfig({ ...cloudProvider(`http://127.0.0.1:${address.port}`, runKey),
    models: [{ id: "gwm_synthetic", name: "Gateway witness", config: catalog, createdAt: null }] });
  await writeFile(config, JSON.stringify({ provider: { lpr_google_witness: provider, ipr_synthetic: aliasProvider } }), { mode: 0o600 });
  // Explicit local isolation requested: no desktop, small_model, inherited
  // config, credentials or running engine database enters this child.
  const child = spawn("/usr/bin/env", ["-i", `PATH=${process.env.PATH}`, `HOME=${home}`, `XDG_CONFIG_HOME=${home}/config`,
    `XDG_DATA_HOME=${home}/data`, `XDG_CACHE_HOME=${home}/cache`, `XDG_STATE_HOME=${home}/state`,
    `OPENCODE_CONFIG=${config}`, "OPENCODE_DISABLE_MODELS_FETCH=1", `OPENCODE_MODELS_URL=http://127.0.0.1:${address.port}`,
    "npm_config_audit=false", binary, "serve", "--hostname", "127.0.0.1", "--port", "0"],
  { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", () => undefined);
  const dispose = async () => {
    await stopChild(child);
    witness.closeAllConnections();
    await new Promise<void>(resolve => witness.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 30_000;
    let base = /opencode server listening on (http:\/\/[^\s]+)/.exec(output)?.[1];
    while (!base && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => setTimeout(resolve, 100));
      base = /opencode server listening on (http:\/\/[^\s]+)/.exec(output)?.[1];
    }
    if (!base) throw new Error("Isolated engine did not start within 30s");
    const engine = async (path: string, body?: unknown): Promise<unknown> => {
      const reply = await fetch(`${base}${path}?directory=${encodeURIComponent(directory)}`, {
        method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000),
      });
      if (reply.status !== 200) throw new Error(`Isolated engine returned ${reply.status}`);
      return reply.json();
    };
    const untrustedRequest = async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/models/${modelID}:generateContent`, {
        method: "POST", headers: { "x-goog-api-key": "fixture-only", "content-type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(3_000),
      });
      return response.status;
    };
    return { engine, untrustedRequest, requests, errors, baseline, live, version, setWording: (message: string) => { wording = message; }, [Symbol.asyncDispose]: dispose };
  } catch (error) { await dispose(); throw error; }
}
