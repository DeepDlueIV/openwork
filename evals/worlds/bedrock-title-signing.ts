import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import type { Seed } from "@openwork/env";
import { bootManagedOpenworkServer, close, listen, readBody, sendJson } from "./openwork-server-cli.ts";

export const BEDROCK_TITLE = "Kites in a sunny meadow";
export const BEDROCK_REPLY = "A kite catches the breeze.";
const secret = "dummy-bedrock-secret-not-a-real-credential";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();

// Independently verify the signature over the headers actually received, not
// the SDK's pre-fetch view. Never retain authorization or header values.
function validSignature(request: IncomingMessage, body: string): boolean {
  const auth = request.headers.authorization ?? "";
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]+)$/.exec(auth);
  if (!match || match[1] !== "dummy-bedrock-access-key") return false;
  const [date, region, service, terminal] = match[2].split("/");
  if (region !== "us-west-2" || service !== "bedrock" || terminal !== "aws4_request") return false;
  const names = match[3].split(";");
  const canonicalHeaders = names.map((name) => {
    const value = request.headers[name];
    return `${name}:${(Array.isArray(value) ? value.join(",") : value ?? "").trim().replace(/\s+/g, " ")}\n`;
  }).join("");
  const url = new URL(request.url ?? "/", "http://localhost");
  const uri = url.pathname.split("/").map((part) => encodeURIComponent(part)).join("/");
  const query = [...url.searchParams].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  const canonical = [request.method, uri, query, canonicalHeaders, match[3], hash(body)].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", request.headers["x-amz-date"], match[2], hash(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), terminal);
  return createHmac("sha256", key).update(stringToSign).digest("hex") === match[4];
}

function frame(type: string, value: unknown): Buffer {
  const headers = Buffer.concat(Object.entries({ ":event-type": type, ":content-type": "application/json", ":message-type": "event" }).map(([name, text]) => {
    const key = Buffer.from(name); const data = Buffer.from(text);
    const prefix = Buffer.alloc(1 + key.length + 3);
    prefix[0] = key.length; key.copy(prefix, 1); prefix[1 + key.length] = 7; prefix.writeUInt16BE(data.length, 2 + key.length);
    return Buffer.concat([prefix, data]);
  }));
  const body = Buffer.from(JSON.stringify(value));
  const message = Buffer.alloc(16 + headers.length + body.length);
  message.writeUInt32BE(message.length, 0); message.writeUInt32BE(headers.length, 4);
  message.writeUInt32BE(crc32(message.subarray(0, 8)), 8);
  headers.copy(message, 12); body.copy(message, 12 + headers.length);
  message.writeUInt32BE(crc32(message.subarray(0, -4)), message.length - 4);
  return message;
}

export async function bedrockTitleSigning(seed: Seed) {
  const root = seed.tmpPath("bedrock-title-signing");
  await mkdir(root, { recursive: true });
  const scratch = await realpath(root);
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  const requests: { title: boolean; signatureValid: boolean; markerPresent: boolean; markerSigned: boolean; status: number; headerNames: string[] }[] = [];
  const witness = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const title = body.includes("Generate a title for this conversation");
      const signatureValid = validSignature(request, body);
      const status = signatureValid ? 200 : 403;
      requests.push({ title, signatureValid, markerPresent: Boolean(request.headers["x-openwork-title-attempt"]),
        markerSigned: Boolean(request.headers.authorization?.match(/SignedHeaders=([^,]+)/)?.[1].split(";").includes("x-openwork-title-attempt")),
        status, headerNames: Object.keys(request.headers).sort() });
      if (!signatureValid) return sendJson(response, 403, { __type: "SignatureDoesNotMatch", message: "The request signature we calculated does not match the signature you provided." });
      response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
      response.end(Buffer.concat([
        frame("messageStart", { role: "assistant" }),
        frame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: title ? BEDROCK_TITLE : BEDROCK_REPLY } }),
        frame("contentBlockStop", { contentBlockIndex: 0 }),
        frame("messageStop", { stopReason: "end_turn" }),
        frame("metadata", { usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, metrics: { latencyMs: 1 } }),
      ]));
    })().catch(() => { if (!response.headersSent) sendJson(response, 500, {}); else response.end(); });
  });
  const endpoint = await listen(witness);
  const modelID = "amazon.nova-micro-v1:0";
  await writeFile(join(workspace, "opencode.json"), JSON.stringify({
    enabled_providers: ["amazon-bedrock"], small_model: `amazon-bedrock/${modelID}`,
    provider: { "amazon-bedrock": { options: { region: "us-west-2", baseURL: endpoint }, whitelist: [modelID],
      models: { [modelID]: { name: "Bedrock signing witness", limit: { context: 128000, output: 4096 } } } } },
  }));
  let managed: Awaited<ReturnType<typeof bootManagedOpenworkServer>> | undefined;
  const dispose = async () => { await managed?.stop(); await close(witness); await rm(scratch, { recursive: true, force: true }); };
  try {
    managed = await bootManagedOpenworkServer({ scratch, workspace, token: "bedrock-signing-witness", sink: () => undefined,
      env: { OPENCODE_LOG_LEVEL: "INFO", AWS_ACCESS_KEY_ID: "dummy-bedrock-access-key", AWS_SECRET_ACCESS_KEY: secret, AWS_SESSION_TOKEN: "", AWS_PROFILE: "", AWS_REGION: "us-west-2" } });
    return { engine: managed.engine, requests, modelID,
      diagnostics: async () => (await readFile(join(scratch, "home/.local/share/opencode/log/opencode.log"), "utf8")).split("\n").filter((line) => line.includes("Automatic title generation")),
      [Symbol.asyncDispose]: dispose };
  } catch (error) { await dispose(); throw error; }
}
