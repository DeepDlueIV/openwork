import { randomUUID } from "node:crypto";
import type { DenSession } from "@openwork/behaviors";
import { evaluateOnSurface } from "@openwork/cdp";
import { SkipError, type Place, type Seed } from "@openwork/env";
import { gatewayEnvironment, startAcmeGateway } from "../../worlds/lib/acme-gateway.ts";
import type { MockMcpTool } from "@openwork/labs";
import { activityTransportFaults } from "./den-dashboard-activity-faults.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { isRecord, records } from "./den-dashboard-activity.ts";

function field(value: unknown, key: string): string {
  const result = isRecord(value) ? value[key] : undefined;
  if (typeof result !== "string" || !result) throw new Error(`Library usage arrangement is missing ${key}.`);
  return result;
}

const skills = {
  draftReply: { plugin: "Support kit", name: "draft-reply", description: "Draft a reply to a customer ticket." },
  summarizeTicket: { plugin: "Support kit", name: "summarize-ticket", description: "Summarize a long ticket thread." },
  quoteBuilder: { plugin: "GitHub", name: "quote-builder", description: "Build a price quote from a request." },
} as const;
type SkillKey = keyof typeof skills;

const trackerTools: MockMcpTool[] = [
  { name: "search_issues", description: "Search the team's issues.", inputSchema: { type: "object", properties: { query: { type: "string" } } }, result: { content: [{ type: "text", text: "3 issues found." }] } },
  { name: "create_issue", description: "Create an issue.", inputSchema: { type: "object", properties: { title: { type: "string" } } }, result: { content: [{ type: "text", text: "Project is archived." }], isError: true } },
];

/**
 * Real Den with Library usage on for one organization: an owner, two
 * teammates, three skills in two plugins, and two connectors served by a
 * local mock MCP server. Nothing is pre-counted; uses are created only when a
 * teammate's agent loads a skill or calls a connector tool through the real
 * OpenWork MCP gateway (`loadSkill`, `callConnector`), exactly as Codex or
 * Claude Code would.
 *
 * The real AI Gateway runs next to Den (in the Den sandbox on Daytona, as a
 * local process on Den's database otherwise). Its rollup job
 * (`POST /internal/rollups/run`, normally a nightly cron) folds Library usage
 * older than two days into daily rows. `foldUsage` runs that job as if it were
 * three days later, so today's uses move into the daily rollups.
 */
export async function libraryUsage(seed: Seed, { place }: { place: Place }) {
  const gatewayAdminToken = randomUUID();
  const stack = new AsyncDisposableStack();
  const den = await seed.den({
    ...(place.kind === "daytona" ? { env: { GATEWAY_ENABLED: "true", GATEWAY_ADMIN_TOKEN: gatewayAdminToken } } : {}),
    org: {
      name: "Support team",
      admin: { name: "Usage Owner" },
      members: { alice: { name: "Alice Teammate" }, blair: { name: "Blair Teammate" } },
    },
    mocks: { tracker: seed.mock({ allowUnauthenticatedMcp: true, tools: trackerTools }) },
  });
  const orgId = await seededOrganizationId(seed, den.admin);
  if (!orgId) throw new Error("Library usage arrangement: the seeded organization is missing");
  const api = async (path: string, init: RequestInit = {}) => {
    const result = await seed.api(den.admin, path, init);
    if (!result.response.ok) throw new Error(`Library usage arrangement ${path}: HTTP ${result.response.status}: ${result.text.slice(0, 300)}`);
    return result.body;
  };

  const capabilities = {} as Record<SkillKey, { capability: string; title: string }>;
  for (const plugin of ["Support kit", "GitHub"] as const) {
    const entries = Object.entries(skills).filter(([, skill]) => skill.plugin === plugin);
    const created = await api("/v1/plugins", {
      method: "POST",
      body: JSON.stringify({
        name: plugin, orgWide: true,
        components: entries.map(([, skill]) => ({ type: "skill", input: {
          rawSourceText: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.description}`,
          metadata: { name: skill.name, description: skill.description },
        } })),
      }),
    });
    const pluginId = field(isRecord(created) ? created.item : undefined, "id");
    const resolved = await api(`/v1/plugins/${pluginId}/resolved`);
    const objects = records(isRecord(resolved) ? resolved.items : undefined).map((entry) => entry.configObject).filter(isRecord);
    for (const [key, skill] of entries) {
      const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
      const object = objects.find((entry) => entry.objectType === "skill" && typeof entry.title === "string" && plain(entry.title) === plain(skill.name));
      if (!object) throw new Error(`Library usage arrangement could not find ${skill.name}.`);
      capabilities[key as SkillKey] = { capability: `plugin:${pluginId}:${field(object, "id")}`, title: field(object, "title") };
    }
  }

  const connectors = { tracker: "Team tracker", wiki: "Old wiki", github: "GitHub" } as const;
  const connectionIds = {} as Record<keyof typeof connectors, string>;
  for (const [key, name] of Object.entries(connectors) as [keyof typeof connectors, string][]) {
    const created = await api("/v1/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ name, url: den.mocks.tracker.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } }),
    });
    connectionIds[key] = field(created, "id");
  }

  // Organization member ids, for reading the per-member usage breakdown.
  const memberIds = {} as Record<"alice" | "blair", string>;
  for (const person of ["alice", "blair"] as const) {
    const session = den.members[person];
    if (!session) throw new Error(`Missing ${person}.`);
    const org = await seed.api(session, "/v1/org");
    memberIds[person] = field(isRecord(org.body) ? org.body.currentMember : undefined, "id");
  }

  const tokens = new Map<DenSession, string>();
  async function mcpToken(person: DenSession) {
    const known = tokens.get(person);
    if (known) return known;
    const minted = await seed.api(person, "/v1/mcp/token", { method: "POST", body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
    const token = field(minted.body, "token");
    tokens.set(person, token);
    return token;
  }
  let requestId = 0;
  async function callTool(person: "alice" | "blair", name: string, args: Record<string, unknown>) {
    const session = den.members[person];
    if (!session) throw new Error(`Missing ${person}.`);
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${await mcpToken(session)}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await response.text();
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const payload: unknown = JSON.parse(data ? data.slice(5) : raw);
    const result = isRecord(payload) && isRecord(payload.result) ? payload.result : null;
    const content = result && Array.isArray(result.content) ? result.content.filter(isRecord) : [];
    return { status: response.status, isError: result?.isError === true, text: content.map((entry) => typeof entry.text === "string" ? entry.text : "").join("\n") };
  }

  /**
   * A teammate's agent loads one skill through the gateway. This is the
   * product action being measured (an agent using a skill), not a write to
   * the usage table; it returns what the agent received.
   */
  async function loadSkill(person: "alice" | "blair", key: SkillKey, tool: "get_skill" | "execute_capability") {
    const result = await callTool(person, tool, { name: capabilities[key].capability });
    return { ...result, servedSkill: result.text.includes(skills[key].description) };
  }

  /** A teammate's agent calls one connector tool through the gateway, as execute_capability does. */
  async function callConnector(person: "alice" | "blair", key: keyof typeof connectors, toolName: string) {
    return callTool(person, "execute_capability", { name: `mcp:${connectionIds[key]}:${toolName}`, body: {} });
  }

  // Locally the gateway is its own process on Den's scratch database; only its rollup route is used.
  let gatewayUrl = den.gateway?.publicUrl ?? null;
  if (!gatewayUrl && place.kind === "local" && den.database?.url) {
    const settings = await gatewayEnvironment("http://127.0.0.1:9");
    await startAcmeGateway(stack, den.database.url, { ...settings, env: { ...settings.env, GATEWAY_ADMIN_TOKEN: gatewayAdminToken } });
    gatewayUrl = settings.baseUrl;
  }

  /** Runs the gateway's real rollup job three days from now, so every use recorded today is folded into daily rows. */
  async function foldUsage() {
    if (!gatewayUrl) throw new SkipError("an AI Gateway next to Den that folds Library usage (local or Daytona placement)");
    const now = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const response = await fetch(`${gatewayUrl}/internal/rollups/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${gatewayAdminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ now }),
    });
    const body: unknown = await response.json().catch(() => null);
    const count = (key: string) => (isRecord(body) && typeof body[key] === "number" ? body[key] : -1);
    return { status: response.status, now, dayBuckets: count("capabilityUsageDayBuckets"), rowsDeleted: count("capabilityUsageRowsDeleted") };
  }

  const viewport = { width: 1280, height: 1000 };
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/analytics", headless: true, viewport });
  const memberWeb = await seed.web({ den, signedInAs: den.members.alice, startPath: "/dashboard", headless: true, viewport });
  const faults = await activityTransportFaults(web, new URL(den.ref.webUrl).origin, "/api/browser/v1/library-usage/");
  return {
    faults,
    async [Symbol.asyncDispose]() {
      await faults[Symbol.asyncDispose]();
      await stack.disposeAsync();
    },
    den, web, memberWeb, orgId, skills: capabilities, connectors, connectionIds, memberIds, loadSkill, callConnector, foldUsage, baseUrl: den.ref.webUrl,
    // Read-only layout witness: probe.dom reports document width and rectangles,
    // but not body scrollWidth or whether sideways scrolling stays in the table.
    usageLayout: () => evaluateOnSurface(web, () => {
      const table = document.querySelector('[data-testid="library-usage-table"]');
      return {
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        table: table ? {
          width: table.clientWidth,
          scrollWidth: table.scrollWidth,
          overflowX: getComputedStyle(table).overflowX,
        } : null,
      };
    }),
  };
}
