// Steps shared by the agent core journeys (evals/core): permissions,
// connectors in chat, live connector and skill changes, models and the
// built-in browser. Everything here goes through what a person sees or the
// OpenWork server's public HTTP API that the app itself calls.
import { createHash } from "node:crypto";
import type { MockAgentToolStep } from "@openwork/labs";
import type { Probe, User } from "@openwork/testkit";

type Engine = "v1" | "v2";
/** The OpenWork server API, as the app calls it (path, method, JSON body). */
export type ServerRequest = (path: string, method?: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The id a mock MCP server records for calls made with `token` (first 12 hex of its SHA-256). */
export function mcpTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/**
 * Send `prompt` from the composer and return the newest assistant reply once
 * the turn has finished. `prepare` scripts the model for this exact prompt.
 */
export async function askAndReadReply(
  actors: { user: User; probe: Probe },
  prompt: string,
  prepare: (prompt: string) => Promise<void>,
  timeoutMs = 90_000,
): Promise<string> {
  const { user, probe } = actors;
  const last = async () => (await probe.dom('[data-message-role="assistant"]')).elements.at(-1)?.text ?? "";
  const previous = await last();
  await prepare(prompt);
  await user.type("composer", prompt);
  await user.click("Run task");
  await user.see({ text: prompt });
  await probe.eventually(last, { within: timeoutMs, intervalMs: 500, label: "a new assistant reply", until: (text) => text.trim() !== "" && text !== previous });
  await user.see("Run task", { timeoutMs: 60_000 });
  return last();
}

/** Workspace connectors managed through OpenWork's server, the way Settings › Connectors does. */
export function workspaceConnectors(request: ServerRequest, workspaceId: string) {
  const root = `/workspace/${encodeURIComponent(workspaceId)}`;
  const config = (url: string, token: string) => ({ type: "remote", url, oauth: false, headers: { Authorization: `Bearer ${token}` } });
  return {
    add: async (name: string, url: string, token: string) => (await request(`${root}/mcp`, "POST", { name, config: config(url, token) })).status,
    remove: async (name: string) => (await request(`${root}/mcp/${encodeURIComponent(name)}`, "DELETE")).status,
    /** A direct write to the v2 engine's own MCP config, bypassing OpenWork. */
    writeEngineDirectly: async (name: string, url: string, token: string) =>
      (await request(`${root}/opencode2/api/experimental/mcp/${encodeURIComponent(name)}`, "PUT", { config: config(url, token) })).status,
    /** Whether OpenWork lists `name` for a workspace (this one by default). */
    lists: async (name: string, otherWorkspaceId = workspaceId) =>
      JSON.stringify((await request(`/workspace/${encodeURIComponent(otherWorkspaceId)}/mcp`)).body).includes(`"${name}"`),
  };
}

/** One turn that calls `tool` on the workspace connector `server`: a direct call on v1, one Code Mode `execute` on v2. */
export function workspaceConnectorSteps(engine: Engine, server: string, tool: string): MockAgentToolStep[] {
  return engine === "v2"
    ? [{ tool: "execute", arguments: { code: `return await tools[${JSON.stringify(server)}].${tool}({});` } }]
    : [{ tool: `${server}_${tool}`, arguments: {}, allowUnadvertisedTool: true }];
}

/** Add a second local folder through the host API and return its workspace id. */
export async function addOtherWorkspace(
  hostRequest: (path: string, method: string, body?: unknown) => Promise<{ status: number; body: unknown }>,
  request: ServerRequest,
  folderPath: string,
): Promise<string> {
  const added = await hostRequest("/workspaces/local", "POST", { folderPath, name: "Unrelated workspace", preset: "starter" });
  if (added.status !== 201) throw new Error(`Adding a second workspace failed: ${added.status}`);
  const listed = await request("/workspaces");
  const items = isRecord(listed.body) && Array.isArray(listed.body.items) ? listed.body.items.filter(isRecord) : [];
  const id = items.find((item) => item.path === folderPath)?.id;
  if (typeof id !== "string") throw new Error("The second workspace is not listed");
  return id;
}

/** Workspace skills managed through OpenWork's server, plus the engine's live skill list. */
export function workspaceSkills(request: ServerRequest, workspaceId: string, engine: Engine) {
  const root = `/workspace/${encodeURIComponent(workspaceId)}`;
  return {
    install: async (name: string, description: string, content: string) => (await request(`${root}/skills`, "POST", { name, description, content })).status,
    remove: async (name: string) => (await request(`${root}/skills/${encodeURIComponent(name)}`, "DELETE")).status,
    /** The engine's skill entry for `name` as JSON, or "" when it is not listed. */
    engineEntry: async (name: string) => {
      const { body } = await request(`${root}/${engine === "v2" ? "opencode2/api" : "opencode"}/skill`);
      const list: unknown[] = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : [];
      const entry = list.find((skill) => isRecord(skill) && skill.name === name);
      return entry === undefined ? "" : JSON.stringify(entry);
    },
  };
}

/** One turn that loads the skill `name` through the engine's skill tool. */
export function skillLoadSteps(engine: Engine, name: string): MockAgentToolStep[] {
  return engine === "v2"
    ? [{ tool: "skill", argumentsFrom: "skill-catalog", arguments: { skill: name } }]
    : [{ tool: "skill", arguments: { name } }];
}

/**
 * One agent turn the scripted model answers by calling `steps`. With `approve`
 * the member clicks Allow once on the prompt; with `deny` they click Deny and
 * the turn may end without a reply. Returns the prompt it sent.
 */
export async function runToolTurn(
  actors: { user: User },
  world: { prepareTurn(prompt: string, reply: string, steps: MockAgentToolStep[]): Promise<void> },
  label: string,
  steps: MockAgentToolStep[],
  options: { approve?: boolean; deny?: boolean } = {},
): Promise<string> {
  const { user } = actors;
  const nonce = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const prompt = `${label} ${nonce()}`;
  const reply = `${label} done. ${nonce()}`;
  await world.prepareTurn(prompt, reply, steps);
  await user.type("composer", prompt);
  await user.click("Run task");
  const answer = options.approve ? "Allow once" : options.deny ? "Deny" : null;
  if (answer) {
    await user.see(answer, { timeoutMs: 120_000 });
    await user.screenshot();
    await user.click(answer);
  }
  if (!options.deny) await user.see({ text: reply }, { timeoutMs: 120_000 });
  return prompt;
}
