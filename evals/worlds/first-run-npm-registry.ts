import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { SkipError, type Seed } from "@openwork/env";
import { bootManagedOpenworkServer, close, engineBinary, listen, type ManagedOpenworkServer } from "./openwork-server-cli.ts";

/** How long the slow registry takes to send the plugin package's metadata: longer than the engine's 10 s npm request limit. */
export const SLOW_METADATA_MS = 13_000;
export const LOCAL_TOOL = "local_probe";
const PACKAGE = "@opencode-ai/plugin";

export type RegistryRequest = { path: string; answered: boolean; ms: number };
export type RegistryMode = "silent" | "slow";

// A minimal ustar archive: npm only needs package/package.json and the entry file.
function tarEntry(name: string, body: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

/**
 * An npm registry on loopback serving one package: the engine's own
 * @opencode-ai/plugin, as a tiny stand-in that exports `tool`. "silent" accepts
 * every request and never answers; "slow" sends the package metadata a few
 * bytes at a time over SLOW_METADATA_MS, so the transfer keeps flowing past the
 * request limit.
 */
async function startRegistry(mode: RegistryMode, version: string) {
  const tarball = gzipSync(Buffer.concat([
    tarEntry("package/package.json", Buffer.from(JSON.stringify({ name: PACKAGE, version, type: "module", main: "index.js", exports: { ".": "./index.js" } }))),
    tarEntry("package/index.js", Buffer.from("export function tool(input) { return input; }\n")),
    Buffer.alloc(1024),
  ]));
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const requests: RegistryRequest[] = [];
  const server: Server = createServer((request, response) => {
    const started = performance.now();
    const entry: RegistryRequest = { path: decodeURIComponent(request.url ?? "/"), answered: false, ms: 0 };
    requests.push(entry);
    const answered = () => { entry.answered = true; entry.ms = Math.round(performance.now() - started); };
    if (mode === "silent") return;
    const base = `http://${request.headers.host}`;
    if (entry.path === `/${PACKAGE}`) {
      const metadata = Buffer.from(JSON.stringify({ name: PACKAGE, "dist-tags": { latest: version }, versions: { [version]: {
        name: PACKAGE, version, type: "module", main: "index.js",
        dist: { tarball: `${base}/${PACKAGE}/-/plugin-${version}.tgz`, integrity },
      } } }));
      response.writeHead(200, { "content-type": "application/json", "content-length": metadata.length });
      void (async () => {
        const pieces = 26;
        for (let piece = 0; piece < pieces; piece += 1) {
          if (response.destroyed) return;
          response.write(metadata.subarray(Math.floor(metadata.length * piece / pieces), Math.floor(metadata.length * (piece + 1) / pieces)));
          await sleep(SLOW_METADATA_MS / pieces);
        }
        response.end(answered);
      })();
      return;
    }
    if (entry.path === `/${PACKAGE}/-/plugin-${version}.tgz`) {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": tarball.length });
      return response.end(tarball, answered);
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}", answered);
  });
  const url = await listen(server);
  return { url, requests, close: () => close(server) };
}

export async function firstRunNpmRegistry(seed: Seed) {
  const binary = engineBinary();
  if (!binary) throw new SkipError("set OPENWORK_OPENCODE_BIN or install opencode");
  // The engine installs the plugin package at its own version.
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim().split(/\s+/).pop()?.replace(/^v/, "") ?? "";
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`Could not read the engine version from ${binary}`);
  const root = seed.tmpPath("first-run-npm-registry");
  await mkdir(root, { recursive: true });
  const scratchRoot = await realpath(root);
  const cleanups: (() => Promise<void>)[] = [];

  /** Starts OpenWork on a fresh profile whose npm registry behaves as `mode`, with a local plugin in the workspace that imports @opencode-ai/plugin. */
  const boot = async (mode: RegistryMode) => {
    const registry = await startRegistry(mode, version);
    cleanups.push(registry.close);
    const scratch = join(scratchRoot, mode);
    const workspace = join(scratch, "workspace");
    await mkdir(join(workspace, ".opencode", "plugins"), { recursive: true });
    await writeFile(join(workspace, ".opencode", "plugins", "local-probe.ts"), [
      `import { tool } from "${PACKAGE}";`,
      "",
      "export const LocalProbe = async () => ({",
      `  tool: { ${LOCAL_TOOL}: tool({ description: "Reports that this workspace's own plugin loaded.", args: {}, execute: async () => "loaded" }) },`,
      "});",
      "",
    ].join("\n"));
    const started = performance.now();
    const managed: ManagedOpenworkServer = await bootManagedOpenworkServer({
      scratch, workspace, token: `first-run-npm-${mode}`, binary, sink: () => undefined,
      env: { npm_config_registry: `${registry.url}/` },
    });
    cleanups.push(() => managed.stop());
    return { answeredMs: Math.round(performance.now() - started), engine: managed.engine, registry: registry.requests, registryUrl: registry.url };
  };

  return {
    version,
    boot,
    [Symbol.asyncDispose]: async () => {
      for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
      await rm(scratchRoot, { recursive: true, force: true });
    },
  };
}
