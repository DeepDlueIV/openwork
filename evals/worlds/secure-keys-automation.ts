import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { denFetch, type DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { eventually } from "@openwork/env";
import { bootCloudModelInfraWorker, registerWorkerAsCloudComputer } from "./infra/cloud-model-infra-worker.ts";

/**
 * A Cloud Automation runs on its owner's OpenWork Web computer, and a provider
 * that issues a separate key to each member reaches that computer only with
 * the owner's own key (#4819, #5370).
 *
 * The owner's computer is a real source-first openwork-server with its
 * managed engine, registered with Den at the database seam the way a Daytona
 * sandbox would be. Den's Daytona endpoint is a ledger that must stay empty.
 * Keys are random per run and only ever compared inside this world.
 */

export const PROVIDER_NAME = "Team Gateway";
const PROVIDER_KEY = "team-gateway";
const PROVIDER_ENV = "TEAM_GATEWAY_API_KEY";
const MODEL_ID = "team-model";
// Never called: the run must stop before any model request.
const PROVIDER_API = "http://127.0.0.1:9/v1";
const GATEWAY_KEY = "per-member-automation-gateway-key";
const REQUEST_TIMEOUT_MS = 30_000;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "skipped"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function at(record: unknown, key: string): Record<string, unknown> {
  const value = isRecord(record) ? record[key] : undefined;
  return isRecord(value) ? value : {};
}
function text(record: unknown, key: string): string {
  const value = isRecord(record) ? record[key] : undefined;
  return typeof value === "string" ? value : "";
}

export async function secureKeysAutomation(seed: Seed) {
  await using stack = new AsyncDisposableStack();
  const secrets = { owner: `sk-owner-${randomBytes(8).toString("hex")}`, teammate: `sk-teammate-${randomBytes(8).toString("hex")}` };

  const daytonaRequests: string[] = [];
  const ledger = createServer((request, response) => {
    daytonaRequests.push(`${request.method ?? "GET"} ${request.url ?? ""}`);
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "this world must not reach the Daytona API" }));
  });
  await new Promise<void>((resolve, reject) => { ledger.once("error", reject); ledger.listen(0, "127.0.0.1", resolve); });
  stack.defer(() => new Promise<void>((resolve) => ledger.close(() => resolve())));
  const address = ledger.address();
  if (!address || typeof address === "string") throw new Error("The Daytona ledger did not bind a TCP port.");

  const den = await seed.den({
    web: false,
    env: {
      DEN_ORG_MODE: "multi_org", DEN_GATEWAY_KEY: GATEWAY_KEY, DEN_OPENWORK_WEB_ENABLED: "true", DEN_AUTOMATIONS_ENABLED: "true",
      DEN_BOOTSTRAP_ADMIN_EMAILS: "per-member-admin@openwork.test", PROVISIONER_MODE: "daytona",
      DAYTONA_API_KEY: "per-member-automation-daytona-guard-key", DAYTONA_API_URL: `http://127.0.0.1:${address.port}`,
      WORKER_PROVISIONING_RECONCILE_INTERVAL_MS: "0", CLOUD_IDLE_LOOP_SECONDS: "0",
    },
    org: {
      name: "Per-member Key Automations",
      admin: { name: "Provider Admin", email: "per-member-admin@openwork.test" },
      members: { owner: { name: "Automation Owner" }, teammate: { name: "Teammate" } },
    },
  });
  const people = { owner: den.members.owner, teammate: den.members.teammate };
  const databaseUrl = den.database?.url;
  if (!people.owner || !people.teammate || !databaseUrl) throw new Error("The isolated Den did not provision both members and its database.");
  const owner = people.owner;

  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  const orgId = text(isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs[0] : null, "id");
  if (!orgId) throw new Error(`Finding the test organization failed: HTTP ${orgs.response.status}`);
  async function call(session: DenSession, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const result = await denFetch(session, path, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId, ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: result.response.status, body: isRecord(result.body) ? result.body : {}, text: result.text };
  }

  const access = await call(den.admin, `/v1/admin/organizations/${orgId}/openwork-web-access`, { method: "PUT", body: { enabled: true, reason: "Per-member key Cloud Automation coverage" } });
  if (access.status >= 300) throw new Error(`Enabling OpenWork Web failed: HTTP ${access.status}`);
  const created = await call(den.admin, "/v1/llm-providers", {
    method: "POST",
    body: {
      name: PROVIDER_NAME, source: "custom",
      customConfig: { id: PROVIDER_KEY, name: PROVIDER_NAME, npm: "@ai-sdk/openai-compatible", env: [PROVIDER_ENV], api: PROVIDER_API, models: [{ id: MODEL_ID, name: "Team model" }] },
      credentialMode: "per_member", allMembers: true, memberIds: [], teamIds: [],
    },
  });
  const providerId = text(at(created.body, "llmProvider"), "id");
  if (created.status !== 201 || !providerId) throw new Error(`Creating the per-member provider failed: HTTP ${created.status}`);

  const computer = await bootCloudModelInfraWorker(stack, {
    name: `per-member-automation-${process.pid}`, workspace: `/tmp/openwork-per-member-automation-${process.pid}`, replace: true,
  });
  const runtime = { url: computer.manifest.openworkUrl, clientToken: computer.manifest.token, hostToken: computer.manifest.hostToken };
  async function computerProviders(): Promise<Record<string, unknown>> {
    const response = await fetch(`${runtime.url}/opencode/config`, { headers: { authorization: `Bearer ${runtime.clientToken}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const payload: unknown = await response.json();
    if (!response.ok) throw new Error(`Reading the computer's models failed: HTTP ${response.status}`);
    return at(payload, "provider");
  }
  async function computerEnv(key: string): Promise<string | null> {
    const response = await fetch(`${runtime.url}/env/${encodeURIComponent(key)}`, { headers: { "x-openwork-host-token": runtime.hostToken }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.status === 404) return null;
    const value = text(at(await response.json(), "item"), "value");
    return response.ok && value ? value : null;
  }
  await eventually(() => computerProviders().then(() => true, () => false), { within: 180_000, intervalMs: 2_000, label: "the computer's engine is serving its config", until: Boolean });
  await registerWorkerAsCloudComputer(databaseUrl, {
    orgId, ownerEmail: owner.email, name: "Automation Owner's computer", sandboxId: `sbx-per-member-automation-${process.pid}`, runtime,
  });

  const resources = stack.move();
  return {
    den, providerId, computerUrl: runtime.url,
    /** A member's own key state for the provider, as the Connect dialog reads it. */
    async keyState(who: keyof typeof people) {
      const session = people[who];
      if (!session) throw new Error(`Missing ${who}`);
      return text(at(at((await call(session, `/v1/llm-providers/${encodeURIComponent(providerId)}/connect`)).body, "llmProvider"), "memberCredential"), "state");
    },
    /** A member saves their own provider key; returns the HTTP status. */
    async saveOwnKey(who: keyof typeof people) {
      const session = people[who];
      if (!session) throw new Error(`Missing ${who}`);
      return (await call(session, `/v1/llm-providers/${encodeURIComponent(providerId)}/my-credential`, { method: "PUT", body: { apiKey: secrets[who] } })).status;
    },
    /** What Den's gateway resolves the owner's OpenWork Web computer to, once it reports ready (or the wait ends). */
    async resolveOwnersComputer() {
      return eventually(async () => {
        const resolved = await call(owner, "/v1/cloud/gateway/resolve", { headers: { "x-openwork-gateway-key": GATEWAY_KEY } });
        return { status: resolved.status, state: text(resolved.body, "status"), url: text(resolved.body, "url") };
      }, { within: 120_000, intervalMs: 3_000, label: "the owner's computer resolves ready", until: (value) => value.status === 200 && value.state === "ready" });
    },
    /** Which member's key, if any, the provider on the owner's computer carries. Keys are compared here, never returned. */
    async keyOnOwnersComputer(): Promise<{ provider: boolean; holder: "owner" | "teammate" | "other" | "none" }> {
      const block = (await computerProviders())[providerId];
      const names = isRecord(block) && Array.isArray(block.env) ? block.env.filter((name): name is string => typeof name === "string") : [PROVIDER_ENV];
      const value = await computerEnv(names[0] ?? PROVIDER_ENV);
      const holder = value === null ? "none" : value === secrets.owner ? "owner" : value === secrets.teammate ? "teammate" : "other";
      return { provider: isRecord(block), holder };
    },
    /** Den pushes the provider to the owner's computer after the owner's key changes; wait until it arrives. */
    async waitForProviderOnOwnersComputer() {
      return eventually(async () => {
        await call(owner, "/v1/cloud/gateway/resolve", { headers: { "x-openwork-gateway-key": GATEWAY_KEY } });
        return this.keyOnOwnersComputer();
      }, { within: 120_000, intervalMs: 3_000, label: "the owner's key reaches their computer", until: (value) => value.provider });
    },
    /** The owner creates a weekly Cloud Automation on the team model and runs it now. */
    async createAndRunAutomation() {
      const automation = await call(owner, "/v1/cloud-automations", {
        method: "POST",
        body: {
          name: "Weekly team summary",
          schedule: { kind: "weekly", timezone: "America/Los_Angeles", daysOfWeek: [1], hour: 9, minute: 0 },
          action: { kind: "agent", instructions: "Summarize last week's team updates.", model: { providerId, modelId: MODEL_ID } },
        },
      });
      const automationId = text(at(automation.body, "automation"), "id");
      const queued = automationId ? await call(owner, `/v1/automations/${encodeURIComponent(automationId)}/run`, { method: "POST", body: {} }) : null;
      return { created: automation.status, queued: queued?.status ?? 0, automationId, runId: text(at(queued?.body, "run"), "id") };
    },
    /** The owner's view of a run once it finishes. */
    async finishedRun(runId: string) {
      const finished = await eventually(() => call(owner, `/v1/automation-runs/${encodeURIComponent(runId)}`), {
        within: 300_000, intervalMs: 3_000, label: "the Cloud Automation run finished",
        until: (value) => TERMINAL_RUN_STATUSES.has(text(at(value.body, "run"), "status")),
      });
      const run = at(finished.body, "run");
      return { status: text(run, "status"), code: text(at(run, "error"), "code"), message: text(at(run, "error"), "message") };
    },
    /** The owner's view of the Automation: its state and why it needs attention. */
    async automation(automationId: string) {
      const automation = at((await call(owner, `/v1/automations/${encodeURIComponent(automationId)}`)).body, "automation");
      const reason = isRecord(automation.needsAttentionReason) ? automation.needsAttentionReason : null;
      return { state: text(automation, "state"), reason: reason ? { code: text(reason, "code"), message: text(reason, "message") } : null };
    },
    async resume(automationId: string) {
      const resumed = await call(owner, `/v1/automations/${encodeURIComponent(automationId)}/activate`, { method: "POST", body: {} });
      return { status: resumed.status, state: text(at(resumed.body, "automation"), "state") };
    },
    daytonaRequests: () => [...daytonaRequests],
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}
