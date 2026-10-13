import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, queryDenDatabase, server, test } from "@openwork/testkit";
import type { Den } from "@openwork/testkit";

// Behaviour proof for agent permission change events
// (src/audit/domain/agent-permissions.ts). With audit capture on, saving
// Everyone's or a team's agent permissions appends agent_permission_policy.updated
// and removing a team's overrides appends agent_permission_policy.removed, inside
// the save's transaction: the scope, every permission before and after, and per
// changed permission its decision and the allowed and blocked patterns added or
// removed. Patterns are recorded as withheld, never as text, since one can hold
// a credential or name a private site. Saving the same settings again records
// nothing. Observed over HTTP plus the disposable scratch database server()
// owns (openwork_eval_*). All identities are synthetic example.test.

const attached = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const daytona = process.env.OPENWORK_EVAL_DAYTONA?.trim() === "1";
const mysqlOpen = !attached && !daytona && await localMysqlIsRunning();
const redisOpen = !attached && !daytona && await localRedisIsRunning();
const skipReason = attached
  ? "needs a fresh local Den with a scratch database (unset OPENWORK_EVAL_DEN_API_URL)"
  : daytona
    ? "needs local placement: the spec inspects the scratch MySQL database directly"
    : !mysqlOpen
      ? "needs MySQL on 127.0.0.1:3306 (pnpm dev:den:mysql)"
      : !redisOpen ? "needs Redis on 127.0.0.1:6379 (pnpm dev:den:mysql)" : "";
const title = skipReason
  ? `agent permission changes are recorded in the audit log (skipped — ${skipReason})`
  : "saving Everyone's and a team's agent permissions, and removing a team's, records each permission's before → after change";

type Row = Record<string, unknown>;
type Envelope = { action: string; operationId: string; resources: Row[]; changes: { before: Row | null; after: Row | null; changedFields: string[] } | null; raw: Row };

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown, label: string): Row {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value)?.slice(0, 500)}`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was not a non-empty string: ${JSON.stringify(value)}`);
  return value;
}
function envelopeOf(value: unknown): Envelope {
  const raw = record(typeof value === "string" ? JSON.parse(value) : value, "audit envelope");
  const changes = isRecord(raw.changes) ? raw.changes : null;
  return {
    action: text(raw.action, "action"),
    operationId: text(raw.operationId, "operationId"),
    resources: Array.isArray(raw.resources) ? raw.resources.filter(isRecord) : [],
    changes: changes ? {
      before: isRecord(changes.before) ? changes.before : null,
      after: isRecord(changes.after) ? changes.after : null,
      changedFields: Array.isArray(changes.changedFields) ? changes.changedFields.filter((field): field is string => typeof field === "string") : [],
    } : null,
    raw,
  };
}

function scratchDatabaseUrl(den: Den): string {
  const url = den.database?.url;
  if (den.placement?.kind !== "local" || !url) throw new Error("This spec requires a testkit-owned local scratch database");
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !parsed.pathname.startsWith("/openwork_eval_")) {
    throw new Error("Refusing audit SQL outside a disposable loopback openwork_eval_* database");
  }
  return url;
}
async function sql(dbUrl: string, statement: string, values: (string | number)[] = []): Promise<Row[]> {
  return (await queryDenDatabase(dbUrl, statement, values)).filter(isRecord);
}
async function watermark(dbUrl: string, orgId: string): Promise<string> {
  const rows = await sql(dbUrl, "SELECT COALESCE(MAX(id), '') AS n FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL", [orgId]);
  return String(rows[0]?.n ?? "");
}
async function changeEventsAfter(dbUrl: string, orgId: string, after: string): Promise<Envelope[]> {
  const rows = await sql(dbUrl, "SELECT envelope FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL AND id > ? ORDER BY id", [orgId, after]);
  return rows.map((row) => envelopeOf(row.envelope)).filter((event) => event.action.startsWith("agent_permission_policy."));
}
function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId };
}
async function organizationIdNamed(session: DenSession, organizationName: string): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: { authorization: `Bearer ${session.token}` } });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  return text(orgs.find((entry) => entry.name === organizationName)?.id, `organization ${organizationName}`);
}

test.skipIf(skipReason !== "")(title, { timeout: 300_000 }, async ({ evidence, place }) => {
  const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const organizationName = `Audit agent permissions ${stamp}`;
  await using den = await server({
    place,
    web: false,
    org: { name: organizationName, admin: { name: "Audit Agent Owner", email: `audit-agent-owner+${stamp}@example.test` } },
    env: { DEN_AUDIT_SELF_HOSTED_ENABLED: "true", DEN_AUDIT_CAPTURE_ENABLED: undefined, DEN_PLAN_GATING_ENABLED: "false", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "" },
  });
  const dbUrl = scratchDatabaseUrl(den);
  const owner = den.admin;
  const orgId = await organizationIdNamed(owner, organizationName);
  const headers = orgHeaders(owner, orgId);
  const features = await denFetch(owner, `/v1/admin/organizations/${orgId}/capabilities`, {
    method: "PUT", headers: { authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ capabilities: { auditLogs: true, agentPermissions: true } }),
  });
  expect(features.response.status, features.text).toBe(200);
  const teamName = `Contractors ${stamp}`;
  const team = await denFetch(owner, "/v1/teams", { method: "POST", headers, body: JSON.stringify({ name: teamName, memberIds: [] }) });
  expect(team.response.status, team.text).toBe(201);
  const teamId = text(record(record(team.body, "team response").team, "team").id, "team id");
  const start = await watermark(dbUrl, orgId);

  const put = async (path: string, settings: Row) => {
    const saved = await denFetch(owner, path, { method: "PUT", headers, body: JSON.stringify({ settings }) });
    expect(saved.response.status, saved.text).toBe(200);
  };
  const secretCommand = `curl --password=example-secret-${stamp} *`;
  const everyone = { commands: { decision: "ask", allow: ["echo *"], block: ["rm *", secretCommand] }, websites: { block: ["example.org"] } };
  await put("/v1/agent-permissions/everyone", everyone);
  await put(`/v1/agent-permissions/teams/${teamId}`, { commands: { decision: "deny", allow: ["git status"] }, localMcpServers: { decision: "deny" } });
  // The same settings again: nothing changed, so nothing is recorded.
  await put("/v1/agent-permissions/everyone", everyone);
  const removed = await denFetch(owner, `/v1/agent-permissions/teams/${teamId}`, { method: "DELETE", headers });
  expect(removed.response.status, removed.text).toBe(204);

  const events = await changeEventsAfter(dbUrl, orgId, start);
  expect(events.map((event) => event.action)).toEqual(["agent_permission_policy.updated", "agent_permission_policy.updated", "agent_permission_policy.removed"]);
  const [everyoneSaved, teamSaved, teamRemoved] = events as [Envelope, Envelope, Envelope];

  expect(everyoneSaved.changes?.before).toMatchObject({ scope: "everyone", teamId: null, commands: null, websites: null });
  expect(everyoneSaved.changes?.after).toMatchObject({
    scope: "everyone",
    commands: { decision: "ask", allow: ["[withheld]"], block: ["[withheld]", "[withheld]"] },
    websites: { decision: null, allow: [], block: ["[withheld]"] },
    permissionChanges: [
      { key: "commands", label: "Run commands", decision: { before: "allow", after: "ask" }, allowAdded: ["[withheld]"], allowRemoved: [], blockAdded: ["[withheld]", "[withheld]"], blockRemoved: [] },
      { key: "websites", label: "Open websites", decision: { before: "allow", after: "allow" }, allowAdded: [], allowRemoved: [], blockAdded: ["[withheld]"], blockRemoved: [] },
    ],
  });
  expect(everyoneSaved.changes?.changedFields).toEqual(["commands", "websites"]);
  expect(everyoneSaved.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "agent_permission_policy", relationship: "target", label: "Everyone" }),
    expect.objectContaining({ type: "organization", id: orgId, relationship: "parent" }),
  ]));
  const stored = JSON.stringify(everyoneSaved.raw);
  expect(stored).not.toContain("example-secret");
  expect(stored).not.toContain("echo *");
  expect(stored).not.toContain("example.org");
  evidence.recordAssertionEvidence(
    "Patterns are recorded as withheld, never as text",
    `commands=${JSON.stringify(everyoneSaved.changes?.after?.commands)}; websites=${JSON.stringify(everyoneSaved.changes?.after?.websites)}`,
    !stored.includes("example-secret") && !stored.includes("echo *") && !stored.includes("example.org"),
  );
  evidence.recordAssertionEvidence(
    "Saving Everyone's permissions records each changed permission's decision and patterns",
    `changedFields=${JSON.stringify(everyoneSaved.changes?.changedFields)}; permissionChanges=${JSON.stringify(everyoneSaved.changes?.after?.permissionChanges)}`,
    everyoneSaved.changes?.changedFields.join(",") === "commands,websites",
  );

  expect(teamSaved.changes?.after).toMatchObject({
    scope: "team", teamId,
    permissionChanges: [
      { key: "commands", decision: { before: "inherit", after: "deny" }, allowAdded: ["[withheld]"] },
      { key: "localMcpServers", decision: { before: "inherit", after: "deny" } },
    ],
  });
  expect(teamSaved.resources).toEqual(expect.arrayContaining([expect.objectContaining({ type: "team", id: teamId, relationship: "target", label: teamName })]));
  expect(teamRemoved.changes?.before).toMatchObject({ scope: "team", teamId, commands: { decision: "deny", allow: ["[withheld]"] }, localMcpServers: { decision: "deny" } });
  expect(teamRemoved.changes?.after).toMatchObject({
    commands: null, localMcpServers: null,
    permissionChanges: [
      { key: "commands", decision: { before: "deny", after: "inherit" }, allowRemoved: ["[withheld]"] },
      { key: "localMcpServers", decision: { before: "deny", after: "inherit" } },
    ],
  });
  evidence.recordAssertionEvidence(
    "A team's save and removal are recorded against the team, and an unchanged save records nothing",
    `actions=${events.map((event) => event.action).join(", ")}; removed changedFields=${JSON.stringify(teamRemoved.changes?.changedFields)}`,
    events.length === 3 && teamRemoved.action === "agent_permission_policy.removed",
  );
  evidence.recordAssertionEvidence("An agent_permission_policy.updated entry as stored", JSON.stringify(everyoneSaved.raw), true);
});
