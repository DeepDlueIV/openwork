import { setTimeout as delay } from "node:timers/promises";

/**
 * Minimal Daytona REST client for evidence worlds. Hot (memory) snapshots are
 * only available through the REST API, not the SDK, so this talks to it directly.
 */
export interface DaytonaConfig {
  apiUrl: string;
  apiKey: string;
  /** Linux VMs (memory snapshots, forks) only exist in some regions. */
  region: string;
}

export const DEFAULT_EVIDENCE_REGION = "us-west-3";

/** Drops trailing slashes without a regular expression (linear on any input). */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

export function daytonaConfig(env: Readonly<Record<string, string | undefined>> = process.env): DaytonaConfig {
  const apiKey = env.DAYTONA_API_KEY?.trim();
  if (!apiKey) throw new Error("DAYTONA_API_KEY is not set. The process that creates Daytona evidence worlds needs it.");
  const apiUrl = trimTrailingSlashes(env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api");
  return { apiUrl, apiKey, region: env.OPENWORK_DAYTONA_EVIDENCE_REGION?.trim() || DEFAULT_EVIDENCE_REGION };
}

export interface Sandbox {
  id: string;
  name: string;
  state: string;
  labels: Record<string, string>;
  toolboxProxyUrl?: string;
  errorReason?: string | null;
  createdAt?: string;
}

export interface Snapshot {
  id: string;
  name: string;
  state: string;
  errorReason?: string | null;
  createdAt?: string;
  lastUsedAt?: string;
}

export class DaytonaApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DaytonaApiError";
    this.status = status;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function labels(value: unknown): Record<string, string> {
  if (!record(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
function asSandbox(value: unknown): Sandbox {
  if (!record(value) || typeof value.id !== "string" || typeof value.state !== "string") throw new Error("Invalid Daytona sandbox response");
  return { id: value.id, name: text(value.name) ?? value.id, state: value.state, labels: labels(value.labels),
    toolboxProxyUrl: text(value.toolboxProxyUrl), errorReason: text(value.errorReason) ?? null, createdAt: text(value.createdAt) };
}
function asSnapshot(value: unknown): Snapshot {
  if (!record(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.state !== "string") throw new Error("Invalid Daytona snapshot response");
  return { id: value.id, name: value.name, state: value.state, errorReason: text(value.errorReason) ?? null,
    createdAt: text(value.createdAt), lastUsedAt: text(value.lastUsedAt) };
}

/** Provider responses can echo request data; never put them in logs beyond this short, token-free summary. */
function errorMessage(body: unknown, status: number): string {
  const message = record(body) && typeof body.message === "string" ? body.message : `HTTP ${status}`;
  return message.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 300);
}

export class DaytonaApi {
  readonly config: DaytonaConfig;
  private readonly request: typeof fetch;

  constructor(config: DaytonaConfig = daytonaConfig(), request: typeof fetch = fetch) {
    this.config = config;
    this.request = request;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.config.apiKey}`, ...extra };
  }

  async call(method: string, path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.request(`${this.config.apiUrl}${path}`, {
          method, headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        if (attempt >= 3) throw error;
        await delay(1_000 * attempt);
        continue;
      }
      const raw = await response.text();
      let parsed: unknown = raw;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { /* plain text body */ }
      if (response.ok) return parsed;
      // Retry gateway hiccups only; client errors are real answers.
      if ([502, 503, 504].includes(response.status) && attempt < 3) { await delay(1_000 * attempt); continue; }
      throw new DaytonaApiError(response.status, `Daytona ${method} ${path.split("?")[0]} failed: ${errorMessage(parsed, response.status)}`);
    }
  }

  async createSandbox(input: { name: string; snapshot: string; labels: Record<string, string>; autoStopMinutes: number; autoDeleteMinutes: number }): Promise<Sandbox> {
    return asSandbox(await this.call("POST", "/sandbox", {
      name: input.name, snapshot: input.snapshot, target: this.config.region, labels: input.labels,
      public: false, autoStopInterval: input.autoStopMinutes, autoDeleteInterval: input.autoDeleteMinutes,
    }));
  }

  async getSandbox(idOrName: string): Promise<Sandbox | null> {
    try { return asSandbox(await this.call("GET", `/sandbox/${encodeURIComponent(idOrName)}`)); }
    catch (error) { if (error instanceof DaytonaApiError && error.status === 404) return null; throw error; }
  }

  async listSandboxes(match: Record<string, string>): Promise<Sandbox[]> {
    const value = await this.call("GET", `/sandbox?labels=${encodeURIComponent(JSON.stringify(match))}`);
    const items = Array.isArray(value) ? value : record(value) && Array.isArray(value.items) ? value.items : [];
    return items.map(asSandbox);
  }

  async waitForSandbox(id: string, states: string[], timeoutMs = 5 * 60_000): Promise<Sandbox> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sandbox = await this.getSandbox(id);
      if (!sandbox) throw new Error(`Daytona sandbox ${id} disappeared`);
      if (states.includes(sandbox.state)) return sandbox;
      if (["error", "build_failed", "destroyed"].includes(sandbox.state)) throw new Error(`Daytona sandbox ${id} is ${sandbox.state}: ${sandbox.errorReason ?? "no reason given"}`);
      if (Date.now() > deadline) throw new Error(`Daytona sandbox ${id} stayed ${sandbox.state}`);
      await delay(2_000);
    }
  }

  async stopSandbox(id: string): Promise<void> {
    await this.call("POST", `/sandbox/${encodeURIComponent(id)}/stop`);
  }

  async deleteSandbox(id: string): Promise<void> {
    try { await this.call("DELETE", `/sandbox/${encodeURIComponent(id)}?force=true`); }
    catch (error) { if (!(error instanceof DaytonaApiError && error.status === 404)) throw error; }
  }

  /** Saves a sandbox as a snapshot. With memory (hot), the sandbox must be running and new sandboxes resume its processes. */
  async snapshotSandbox(id: string, name: string, includeMemory: boolean): Promise<void> {
    await this.call("POST", `/sandbox/${encodeURIComponent(id)}/snapshot`, { name, includeMemory });
  }

  async createImageSnapshot(input: { name: string; image: string; cpu: number; memory: number; disk: number }): Promise<void> {
    await this.call("POST", "/snapshots", { name: input.name, imageName: input.image, sandboxClass: "linux-vm",
      regionId: this.config.region, cpu: input.cpu, memory: input.memory, disk: input.disk });
  }

  async getSnapshot(name: string): Promise<Snapshot | null> {
    try { return asSnapshot(await this.call("GET", `/snapshots/${encodeURIComponent(name)}`)); }
    catch (error) { if (error instanceof DaytonaApiError && error.status === 404) return null; throw error; }
  }

  async waitForSnapshot(name: string, timeoutMs = 20 * 60_000): Promise<Snapshot> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = await this.getSnapshot(name);
      if (snapshot?.state === "active") return snapshot;
      if (snapshot && /error|fail/.test(snapshot.state)) throw new Error(`Daytona snapshot ${name} is ${snapshot.state}: ${snapshot.errorReason ?? "no reason given"}`);
      if (Date.now() > deadline) throw new Error(`Daytona snapshot ${name} is still ${snapshot?.state ?? "missing"}`);
      await delay(3_000);
    }
  }

  async listSnapshots(): Promise<Snapshot[]> {
    const items: Snapshot[] = [];
    for (let page = 1; page <= 50; page++) {
      const value = await this.call("GET", `/snapshots?page=${page}&limit=100`);
      const batch = record(value) && Array.isArray(value.items) ? value.items : Array.isArray(value) ? value : [];
      items.push(...batch.map(asSnapshot));
      if (batch.length < 100) break;
    }
    return items;
  }

  async deleteSnapshot(id: string): Promise<void> {
    try { await this.call("DELETE", `/snapshots/${encodeURIComponent(id)}`); }
    catch (error) { if (!(error instanceof DaytonaApiError && error.status === 404)) throw error; }
  }

  /** Copies a running VM sandbox, memory included, into a new independent sandbox. */
  async forkSandbox(id: string, name: string): Promise<Sandbox> {
    return asSandbox(await this.call("POST", `/sandbox/${encodeURIComponent(id)}/fork`, { name }));
  }

  async setLabels(id: string, value: Record<string, string>): Promise<void> {
    await this.call("PUT", `/sandbox/${encodeURIComponent(id)}/labels`, { labels: value });
  }

  /**
   * Browser-usable preview URL: the token is in the host name, so no header is
   * needed. It stops working after `expiresInSeconds`.
   */
  async signedPreviewUrl(id: string, port: number, expiresInSeconds: number): Promise<string> {
    const value = await this.call("GET", `/sandbox/${encodeURIComponent(id)}/ports/${port}/signed-preview-url?expiresInSeconds=${expiresInSeconds}`);
    if (!record(value) || typeof value.url !== "string") throw new Error("Invalid Daytona signed preview URL response");
    return trimTrailingSlashes(value.url);
  }

  /** Private preview URL for a port; requests must send `x-daytona-preview-token: <token>`. */
  async previewUrl(id: string, port: number): Promise<{ url: string; token: string }> {
    const value = await this.call("GET", `/sandbox/${encodeURIComponent(id)}/ports/${port}/preview-url`);
    if (!record(value) || typeof value.url !== "string" || typeof value.token !== "string") throw new Error("Invalid Daytona preview URL response");
    return { url: trimTrailingSlashes(value.url), token: value.token };
  }

  private toolbox(sandbox: Sandbox): string {
    return sandbox.toolboxProxyUrl ? `${trimTrailingSlashes(sandbox.toolboxProxyUrl)}/${sandbox.id}` : `${this.config.apiUrl}/toolbox/${sandbox.id}/toolbox`;
  }

  /** Runs a short command as the sandbox user (root on our images). Long work runs as a systemd unit instead. */
  async exec(sandbox: Sandbox, command: string, timeoutSeconds = 120): Promise<{ exitCode: number; output: string }> {
    const response = await this.request(`${this.toolbox(sandbox)}/process/execute`, {
      method: "POST", headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ command, timeout: timeoutSeconds }), signal: AbortSignal.timeout((timeoutSeconds + 30) * 1000),
    });
    const raw = await response.text();
    if (!response.ok) throw new DaytonaApiError(response.status, `Daytona exec failed (HTTP ${response.status})`);
    const value: unknown = JSON.parse(raw);
    if (!record(value)) throw new Error("Invalid Daytona exec response");
    return { exitCode: typeof value.exitCode === "number" ? value.exitCode : -1, output: text(value.result) ?? "" };
  }

  async execChecked(sandbox: Sandbox, command: string, timeoutSeconds = 120): Promise<string> {
    const result = await this.exec(sandbox, command, timeoutSeconds);
    // Keep this prefix: callers log only messages that start with it.
    if (result.exitCode !== 0) throw new Error(`Daytona guest command failed (exit ${result.exitCode}).`);
    return result.output;
  }

  async writeFile(sandbox: Sandbox, path: string, content: string, mode?: number): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([content]), path.split("/").pop() ?? "file");
    const response = await this.request(`${this.toolbox(sandbox)}/files/upload?path=${encodeURIComponent(path)}`, {
      method: "POST", headers: this.headers(), body: form, signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new DaytonaApiError(response.status, `Daytona upload of ${path} failed (HTTP ${response.status})`);
    if (mode !== undefined) await this.execChecked(sandbox, `chmod ${mode.toString(8)} '${path}'`, 30);
  }

  async readFile(sandbox: Sandbox, path: string): Promise<string | null> {
    const response = await this.request(`${this.toolbox(sandbox)}/files/download?path=${encodeURIComponent(path)}`, {
      headers: this.headers(), signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      // Some toolbox versions answer 400 for a missing file.
      if (response.status === 400) return null;
      throw new DaytonaApiError(response.status, `Daytona download of ${path} failed (HTTP ${response.status})`);
    }
    return response.text();
  }
}
