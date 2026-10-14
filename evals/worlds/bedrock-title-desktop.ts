import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { bedrockObserverSource } from "./bedrock-title-live.ts";
import { configureProvider } from "./chat.ts";
import { isRecord } from "./openwork-server-cli.ts";

export async function bedrockTitleDesktop(seed: Seed) {
  await using setup = new AsyncDisposableStack();
  const scratch = seed.tmpPath("bedrock-title-desktop");
  setup.defer(() => rm(scratch, { recursive: true, force: true }));
  const profile = join(scratch, "profile");
  const workspacePath = join(scratch, "workspace");
  const receiptPath = join(scratch, "sanitized-receipts.jsonl");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(join(profile, "electron-userdata/openwork-dev-data/xdg/data/opencode/log"), { recursive: true });
  const logPipe = join(profile, "electron-userdata/openwork-dev-data/xdg/data/opencode/log/opencode.log");
  await new Promise<void>((resolve, reject) => execFile("mkfifo", [logPipe], (error) => error ? reject(error) : resolve()));
  await writeFile(receiptPath, "");
  // A FIFO keeps raw logs off disk. Retain only the engine's title outcome/status.
  const logs = createReadStream(logPipe, { encoding: "utf8" });
  let pending = "";
  let writes = Promise.resolve();
  setup.defer(async () => { logs.destroy(); await writes; });
  logs.on("data", (chunk) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (!line.includes("Automatic title generation")) continue;
      const outcome = /outcome=([a-z_]+)/.exec(line)?.[1];
      const status = /status=(\d+)/.exec(line)?.[1];
      if (outcome) writes = writes.then(() => appendFile(receiptPath, JSON.stringify({ diagnostic: "Automatic title generation", outcome, ...(status ? { status: Number(status) } : {}) }) + "\n"));
    }
  });
  const observer = join(scratch, "observer.ts");
  await writeFile(observer, bedrockObserverSource(receiptPath));
  const env: Record<string, string> = { AWS_REGION: "us-west-2", AWS_PROFILE: "", OPENCODE_LOG_LEVEL: "INFO" };
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
    const value = process.env[name];
    if (!value) throw new Error("Missing live AWS process credentials");
    env[name] = value;
  }
  const modelID = "amazon.nova-micro-v1:0";
  await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({ plugin: [observer], small_model: `amazon-bedrock/${modelID}` }));
  const app = await seed.desktop({ name: "bedrock-title-fixed", profileDir: profile, env });
  setup.defer(() => app.stop());
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "amazon-bedrock", modelID, {
    provider: { "amazon-bedrock": { options: { region: "us-west-2" }, whitelist: [modelID], models: { [modelID]: { name: "Amazon Nova Micro" } } } },
  }, "v1");
  const resources = setup.move();
  return { app, workspace,
    receipts: async () => (await readFile(receiptPath, "utf8")).split("\n").filter(Boolean).map((line): unknown => JSON.parse(line)).filter(isRecord),
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}
