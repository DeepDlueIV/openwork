import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, mcpMock, server, test } from "@openwork/testkit";

// Behaviour proof that agent permissions cover the organization's own skills
// and MCP connections, not only what members install on their computers. A
// member's agent reaches both through Den's agent MCP: once Everyone blocks a
// skill and a connection, Den no longer lists the skill, refuses to serve it,
// and refuses calls to the connection, through Connect and the direct
// connection endpoint alike, naming the rule. Observed over HTTP against a
// local Den with a mock MCP connector. All identities are synthetic example.test.

const attached = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const daytona = process.env.OPENWORK_EVAL_DAYTONA?.trim() === "1";
const mysqlOpen = daytona || attached || await localMysqlIsRunning();
const redisOpen = daytona || attached || await localRedisIsRunning();
const title = !mysqlOpen
  ? "agent permissions for organization skills and connections skipped — needs MySQL on 127.0.0.1:3306"
  : !redisOpen
    ? "agent permissions for organization skills and connections skipped — needs Redis on 127.0.0.1:6379"
    : "a member's agent loses an organization skill and connection once Everyone blocks them (the connection by its server's address), and is told the rule";

const BLOCKED_SKILL = "share-plugin";
let requestId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value)?.slice(0, 500)}`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was not a non-empty string: ${JSON.stringify(value)}`);
  return value;
}
function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId };
}
async function organizationIdNamed(session: DenSession, organizationName: string): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: { authorization: `Bearer ${session.token}` } });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  return text(orgs.find((entry) => entry.name === organizationName)?.id, `organization ${organizationName}`);
}
async function mintMcpToken(session: DenSession, orgId: string): Promise<string> {
  const result = await denFetch(session, "/v1/mcp/token", { method: "POST", headers: orgHeaders(session, orgId), body: JSON.stringify({}) });
  const token = isRecord(result.body) && typeof result.body.token === "string" ? result.body.token : "";
  if (!result.response.ok || !token.startsWith("ow_mcp_at_")) throw new Error(`Minting an MCP token failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
  return token;
}
/** One JSON-RPC request to an MCP endpoint; returns the HTTP status and the payload (SSE data frame or JSON). */
async function mcpRequest(url: string, token: string, method: string, params: Record<string, unknown>): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  const body = dataLine ? dataLine.slice(5) : raw;
  let payload: unknown = body;
  try { payload = JSON.parse(body); } catch { payload = body; }
  return { status: response.status, payload };
}
/** A tool result's text, whether it succeeded or is an error result; a JSON error result's message when it has one. */
function toolResultText(payload: unknown): string {
  const result = record(record(payload, "JSON-RPC payload").result, "tool result");
  const raw = Array.isArray(result.content) ? result.content.filter(isRecord).map((part) => String(part.text ?? "")).join("\n") : "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.message === "string") return `${String(parsed.error ?? "")}: ${parsed.message}`;
  } catch {
    // SKILL.md and other plain text.
  }
  return raw;
}
function listedSkillNames(payload: unknown): string[] {
  const structured = record(record(record(payload, "JSON-RPC payload").result, "tool result").structuredContent, "list_skills content");
  return Array.isArray(structured.skills) ? structured.skills.filter(isRecord).map((skill) => String(skill.name)) : [];
}

test.skipIf(!mysqlOpen || !redisOpen)(title, { timeout: 300_000 }, async ({ evidence, place }) => {
  const stamp = Date.now().toString(36);
  const organizationName = `Agent permissions cloud ${stamp}`;
  const connectionName = `Issue Tracker ${stamp}`;
  await using den = await server({
    place,
    web: false,
    mocks: { connector: mcpMock({ allowUnauthenticatedMcp: true }) },
    org: { name: organizationName, members: { riley: { name: "Riley Contractor", email: `riley+${stamp}@example.test` } } },
    env: { DEN_PLAN_GATING_ENABLED: "false" },
  });
  const owner = den.admin;
  const riley = den.members.riley;
  if (!riley) throw new Error("Riley's session is missing");
  const orgId = await organizationIdNamed(owner, organizationName);
  const headers = orgHeaders(owner, orgId);
  const features = await denFetch(owner, `/v1/admin/organizations/${orgId}/capabilities`, {
    method: "PUT", headers: { authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ capabilities: { agentPermissions: true } }),
  });
  expect(features.response.status, features.text).toBe(200);
  const created = await denFetch(owner, "/v1/mcp-connections", {
    method: "POST", headers,
    body: JSON.stringify({ name: connectionName, url: den.mocks.connector.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } }),
  });
  expect(created.response.status, created.text).toBeLessThan(300);
  const connectionId = text(record(isRecord(created.body) && isRecord(created.body.connection) ? created.body.connection : created.body, "connection").id, "connection id");

  // Connections match by their server's address, which members cannot change, not by their name.
  const connectionHost = new URL(den.mocks.connector.mcpUrl).hostname;
  const agentUrl = `${den.ref.apiUrl}/mcp/agent`;
  const directUrl = `${agentUrl}/connections/${encodeURIComponent(connectionId)}`;
  const token = await mintMcpToken(riley, orgId);
  const callTool = (name: string, args: Record<string, unknown>) => mcpRequest(agentUrl, token, "tools/call", { name, arguments: args });
  const initialize = () => mcpRequest(directUrl, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-permissions-cloud", version: "1" } });
  const capability = `mcp:${connectionId}:list_issues`;

  // Before: the skill is listed and served, and the connection is reachable.
  const listedBefore = listedSkillNames((await callTool("list_skills", {})).payload);
  const skillBefore = toolResultText((await callTool("get_skill", { name: BLOCKED_SKILL })).payload);
  const executeSkillBefore = toolResultText((await callTool("execute_capability", { name: `skill:${BLOCKED_SKILL}`, arguments: {} })).payload);
  const directBefore = await initialize();
  const executeBefore = toolResultText((await callTool("execute_capability", { name: capability, arguments: {} })).payload);
  evidence.recordAssertionEvidence("before: Riley's agent can use the organization's skill and connection",
    `${BLOCKED_SKILL} listed: ${listedBefore.includes(BLOCKED_SKILL)}; get_skill returned ${skillBefore.length} characters; direct connection initialize → HTTP ${directBefore.status}; execute_capability → ${executeBefore.slice(0, 160)}`,
    listedBefore.includes(BLOCKED_SKILL) && skillBefore.length > 200 && directBefore.status === 200 && !executeBefore.includes("agent permissions"));
  expect(listedBefore).toContain(BLOCKED_SKILL);
  expect(skillBefore.length).toBeGreaterThan(200);
  expect(executeSkillBefore).not.toContain("agent permissions");
  expect(directBefore.status).toBe(200);
  expect(executeBefore).not.toContain("agent permissions");

  const saved = await denFetch(owner, "/v1/agent-permissions/everyone", {
    method: "PUT", headers, body: JSON.stringify({ settings: { localSkills: { block: [BLOCKED_SKILL] }, localMcpServers: { block: [connectionHost] } } }),
  });
  expect(saved.response.status, saved.text).toBe(200);

  // After: gone from the catalog, refused when asked for by name, and the connection refuses calls.
  const listedAfter = listedSkillNames((await callTool("list_skills", {})).payload);
  const skillAfter = toolResultText((await callTool("get_skill", { name: BLOCKED_SKILL })).payload);
  const executeSkillAfter = toolResultText((await callTool("execute_capability", { name: `skill:${BLOCKED_SKILL}`, arguments: {} })).payload);
  const directAfter = await initialize();
  const directMessage = isRecord(directAfter.payload) ? String(directAfter.payload.message ?? "") : String(directAfter.payload);
  const executeAfter = toolResultText((await callTool("execute_capability", { name: capability, arguments: {} })).payload);
  const skillRule = `block the skill "${BLOCKED_SKILL}" ("${BLOCKED_SKILL}" is blocked for Everyone)`;
  const connectionRule = `block the MCP server "${connectionHost}" ("${connectionHost}" is blocked for Everyone)`;
  evidence.recordAssertionEvidence("after: the blocked skill is hidden and refused, naming the rule",
    `${BLOCKED_SKILL} listed: ${listedAfter.includes(BLOCKED_SKILL)}; get_skill → ${skillAfter.slice(0, 200)}; execute_capability skill:${BLOCKED_SKILL} → ${executeSkillAfter.slice(0, 200)}`,
    !listedAfter.includes(BLOCKED_SKILL) && skillAfter.includes(skillRule) && executeSkillAfter.includes(skillRule));
  evidence.recordAssertionEvidence("after: the blocked connection refuses Riley's agent through Connect and directly",
    `direct initialize → HTTP ${directAfter.status} ${directMessage.slice(0, 160)}; execute_capability → ${executeAfter.slice(0, 200)}`,
    directAfter.status === 403 && directMessage.includes(connectionRule) && executeAfter.includes(connectionRule));
  expect(listedAfter).not.toContain(BLOCKED_SKILL);
  expect(listedAfter.length).toBeGreaterThan(0);
  expect(skillAfter).toContain(skillRule);
  expect(executeSkillAfter).toContain(skillRule);
  expect(directAfter.status).toBe(403);
  expect(directMessage).toContain(connectionRule);
  expect(executeAfter).toContain(connectionRule);
});
