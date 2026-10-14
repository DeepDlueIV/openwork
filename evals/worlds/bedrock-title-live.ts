import { spawn } from "node:child_process";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Seed } from "@openwork/env";
import { buildOpenworkRuntimeConfigObjectFromSnapshot } from "../../apps/server/src/openwork-runtime-config.ts";
import { engineBinary, isRecord, stopChild } from "./openwork-server-cli.ts";

// Observe the real AWS response in memory, retaining only names/status and a
// signature-error boolean. Replace provider error text before the engine can
// persist it (AWS error text can echo signing material).
export function bedrockObserverSource(receiptPath?: string): string {
  return `import { appendFile } from "node:fs/promises";
const receiptPath = ${JSON.stringify(receiptPath ?? null)};
const emit = async (value) => {
  const line = JSON.stringify(value);
  if (receiptPath) await appendFile(receiptPath, line + "\\n");
  else console.error("BEDROCK_RECEIPT " + line);
};
export const ObserveBedrock = async () => {
  const base = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const auth = headers.get("authorization") ?? "";
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("bedrock-runtime.") || !auth.startsWith("AWS4-HMAC-SHA256")) return base(input, init);
    const response = await base(input, init);
    const title = auth.match(/SignedHeaders=([^,]+)/)?.[1].split(";").includes("x-openwork-title-attempt") ?? false;
    const text = response.ok ? "" : await response.clone().text();
    const signatureError = /SignatureDoesNotMatch|signature we calculated does not match/i.test(text);
    await emit({ title, headerNames: [...headers.keys()].sort(), status: response.status, signatureError });
    if (response.ok) return response;
    const message = signatureError ? "The request signature we calculated does not match the signature you provided." : response.status === 429 ? "Rate limit" : "Model access rejected";
    const safe = new Headers(response.headers);
    safe.delete("content-length"); safe.delete("content-encoding");
    return new Response(JSON.stringify({ message }), { status: response.status, headers: safe });
  }, base);
  return {};
};`;
}

export async function liveBedrockTitle(seed: Seed) {
  const column = process.env.OPENWORK_BEDROCK_COLUMN ?? "C";
  const root = seed.tmpPath(`live-bedrock-${column}`);
  await mkdir(root, { recursive: true });
  const scratch = await realpath(root);
  const home = join(scratch, "home");
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(home, ".local/share/opencode/log"), { recursive: true });
  // No raw engine log is retained. Only allowlisted stderr receipts survive.
  await symlink("/dev/null", join(home, ".local/share/opencode/log/opencode.log"));
  const observer = join(scratch, "observer.ts");
  await writeFile(observer, bedrockObserverSource());
  const runtime = buildOpenworkRuntimeConfigObjectFromSnapshot({});
  if (!Array.isArray(runtime.plugin) || !runtime.plugin.every((value) => typeof value === "string")) throw new Error("Missing runtime plugins");
  let plugins: string[] = runtime.plugin;
  let binary = engineBinary();
  if (column === "A") {
    const resources = process.env.OPENWORK_BEDROCK_RELEASE_RESOURCES;
    if (!resources) throw new Error("Release resources required for column A");
    plugins = plugins.map((path) => join(resources, "opencode-plugins", basename(path).replace(/\.ts$/, ".js")));
    binary = join(resources, "sidecars/opencode");
  } else if (column === "B") {
    const control = process.env.OPENWORK_BEDROCK_CONTROL_PLUGIN;
    if (!control) throw new Error("Unmodified control plugin required for column B");
    plugins = plugins.map((path) => path.includes("openwork-title-recovery") ? control : path);
  }
  if (!binary) throw new Error("Pinned engine binary required");
  const modelID = process.env.OPENWORK_BEDROCK_LIVE_MODEL ?? "amazon.nova-micro-v1:0";
  const config = { ...runtime, plugin: [observer, ...plugins], enabled_providers: ["amazon-bedrock"],
    small_model: `amazon-bedrock/${modelID}`,
    provider: { "amazon-bedrock": { options: { region: "us-west-2" }, whitelist: [modelID] } } };
  await writeFile(join(workspace, "opencode.json"), JSON.stringify(config));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE") && !key.startsWith("OPENWORK_")));
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs", "--log-level", "INFO"], {
    cwd: workspace, env: { ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"), AWS_REGION: "us-west-2", AWS_PROFILE: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const receipts: { title: boolean; headerNames: string[]; status: number; signatureError: boolean }[] = [];
  const diagnostics: string[] = [];
  let base = "";
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => { base = /http:\/\/127\.0\.0\.1:\d+/.exec(chunk.toString())?.[0] ?? base; });
  child.stderr.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (line.startsWith("BEDROCK_RECEIPT ")) receipts.push(JSON.parse(line.slice(16)));
      if (line.includes("Automatic title generation")) {
        const outcome = /outcome=([a-z_]+)/.exec(line)?.[1];
        const status = /status=(\d+)/.exec(line)?.[1];
        if (outcome) diagnostics.push(`Automatic title generation outcome=${outcome}${status ? ` status=${status}` : ""}`);
      }
    }
  });
  const dispose = async () => { await stopChild(child); await rm(scratch, { recursive: true, force: true }); };
  try {
    const deadline = Date.now() + 120_000;
    while (!base && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 250));
    if (!base) throw new Error("Live engine did not bind");
    const engine = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Engine API status ${response.status}`);
      return response.json();
    };
    const configSeen = await engine("GET", "/config");
    if (!isRecord(configSeen) || !Array.isArray(configSeen.plugin) || configSeen.plugin.length < plugins.length) throw new Error("OpenWork plugins were not loaded");
    return { column, engine, modelID, receipts, diagnostics, [Symbol.asyncDispose]: dispose };
  } catch (error) { await dispose(); throw error; }
}
