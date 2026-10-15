import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { allocateFreePort } from "@openwork/cdp";
import { localMysqlIsRunning, SkipError, type Place, type Seed } from "@openwork/env";
import { defaultDaytonaExec, execInSandbox, startScriptOnSandbox } from "@openwork/hosts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { usageRecord, usageRecords, usageString } from "./gateway-usage-policy.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const upstreamScript = fileURLToPath(new URL("../packages/labs/src/priced-upstream.mjs", import.meta.url));
const upstreamKey = "gateway-provider-limits-upstream-only";
// Inside a Daytona Den sandbox the Gateway reaches the upstream on this loopback port.
const DAYTONA_UPSTREAM_PORT = 3991;

type Upstream = { baseUrl: string; requests(): Promise<number> };

/** The priced upstream as a local process. */
async function localUpstream(setup: AsyncDisposableStack): Promise<Upstream> {
  const port = await allocateFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [upstreamScript], {
    stdio: "ignore",
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), PRICED_UPSTREAM_KEY: upstreamKey, PRICED_UPSTREAM_COST_USD: "1" },
  });
  setup.defer(() => { child.kill("SIGTERM"); });
  const deadline = Date.now() + 15_000;
  while (!await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok).catch(() => false)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error("Priced upstream did not start");
    await delay(100);
  }
  return {
    baseUrl,
    async requests() {
      return usageRecords(await fetch(`${baseUrl}/requests`).then((response) => response.json())).length;
    },
  };
}

/** The Gateway as a local process on Den's scratch database. */
async function localGateway(setup: AsyncDisposableStack, input: { databaseUrl: string; port: number; upstreamOrigin: string }) {
  const gatewayUrl = `http://127.0.0.1:${input.port}`;
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "src/server.ts"], {
    cwd: `${root}/ee/apps/gateway`, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", OPENWORK_DEV_MODE: "1",
      PORT: String(input.port), GATEWAY_PORT: String(input.port), GATEWAY_ENABLED: "true",
      DATABASE_URL: input.databaseUrl, DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
      GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl,
      GATEWAY_EGRESS_ALLOWED_ORIGINS: input.upstreamOrigin, GATEWAY_WEBHOOK_SECRET: "provider-limits-webhook-only",
      SENTRY_DSN: "", SENTRY_LOG_LEVEL: "off",
    },
  });
  let logs = "";
  child.stdout?.on("data", (chunk) => { logs = `${logs}${String(chunk)}`.slice(-8000); });
  child.stderr?.on("data", (chunk) => { logs = `${logs}${String(chunk)}`.slice(-8000); });
  setup.defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  });
  const deadline = Date.now() + 60_000;
  while (true) {
    if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`Gateway readiness failed (exit ${child.exitCode}): ${logs}`);
    if (await fetch(`${gatewayUrl}/ready`, { signal: AbortSignal.timeout(2000) }).then((response) => response.ok).catch(() => false)) break;
    await delay(500);
  }
  return gatewayUrl;
}

/**
 * Den + Gateway with two Gateway providers (A and B) on one deterministic
 * upstream that reports $1 per call, one member connected to both, per-provider
 * usage limits on for the organization, a $1 monthly default limit for
 * everyone, the admin in Den web and the member in the app.
 *
 * Local: Gateway and upstream are processes on this machine next to a scratch
 * MySQL database. Daytona: Den starts the Gateway in its sandbox and the
 * upstream script is uploaded next to it, so both talk over its loopback.
 */
export async function gatewayProviderUsageLimits(seed: Seed, { place }: { place: Place }) {
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim() || process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim()) throw new Error("Provider usage journey requires a fresh testkit Den, never an attached service");
  if (place.kind === "local" && !await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable openwork_eval_ database");
  await using setup = new AsyncDisposableStack();
  const daytona = place.kind === "daytona";
  const upstream = daytona ? null : await localUpstream(setup);
  const upstreamBaseUrl = upstream?.baseUrl ?? `http://127.0.0.1:${DAYTONA_UPSTREAM_PORT}`;
  const localGatewayPort = daytona ? null : await allocateFreePort();
  const localGatewayUrl = localGatewayPort ? `http://127.0.0.1:${localGatewayPort}` : null;
  const { den, webPort } = await denForAppWeb(seed, {
    web: true,
    schema: "migrate",
    env: {
      OPENWORK_DEV_MODE: "1", DEN_ORG_MODE: "multi_org", DEN_PLAN_GATING_ENABLED: "false",
      GATEWAY_ENABLED: "true", GATEWAY_EGRESS_ALLOWED_ORIGINS: upstreamBaseUrl,
      RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
      // On Daytona the sandbox's start script owns the Gateway origins and process.
      ...(localGatewayUrl ? {
        NODE_ENV: "test", DB_MODE: "mysql", PROVISIONER_MODE: "stub",
        GATEWAY_PROXY_BASE_URL: localGatewayUrl, GATEWAY_PUBLIC_BASE_URL: localGatewayUrl,
      } : {}),
    },
    org: {
      name: `Provider Limits Journey ${Date.now()}`,
      admin: { name: "Limits Admin", email: "provider-limits-admin@example.test" },
      members: { member: { name: "Limits Member", email: "provider-limits-member@example.test" } },
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("Expected a synthetic member session");

  let gatewayUrl: string;
  let upstreamRequests: () => Promise<number>;
  if (daytona) {
    const sandbox = den.placement?.kind === "daytona" ? den.placement.sandboxId : null;
    if (!sandbox || !den.gateway) throw new Error("Daytona Den did not report its sandbox and co-located AI Gateway");
    gatewayUrl = den.gateway.publicUrl;
    const witness = await startScriptOnSandbox({
      sandbox, label: "priced-upstream", port: DAYTONA_UPSTREAM_PORT,
      scriptSource: await readFile(upstreamScript, "utf8"),
      env: { PRICED_UPSTREAM_KEY: upstreamKey, PRICED_UPSTREAM_COST_USD: "1" },
      log: (line) => console.error(`[provider-limits] ${line}`),
    });
    // The Den disposer may already have deleted the sandbox; then there is nothing to stop.
    setup.defer(() => witness.stop().catch(() => undefined));
    upstreamRequests = async () => {
      const result = await execInSandbox(defaultDaytonaExec, sandbox, `curl -s ${upstreamBaseUrl}/requests`, { timeoutMs: 30_000, context: "priced upstream witness read" });
      return usageRecords(JSON.parse(result.stdout.trim() || "[]")).length;
    };
  } else {
    const databaseUrl = den.database?.url;
    if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_") || !localGatewayPort || !upstream) throw new Error("Expected testkit scratch database");
    gatewayUrl = await localGateway(setup, { databaseUrl, port: localGatewayPort, upstreamOrigin: upstreamBaseUrl });
    upstreamRequests = upstream.requests;
  }

  const orgResponse = await seed.api(den.admin, "/v1/org");
  if (!orgResponse.response.ok) throw new Error(`Org lookup: HTTP ${orgResponse.response.status}`);
  const org = usageRecord(orgResponse.body);
  const orgId = usageString(usageRecord(org.organization).id);
  const memberId = usageString(usageRecords(org.members).find((row) => usageRecord(row.user).email === member.email)?.id);

  async function provider(name: string) {
    const created = await seed.api(den.admin, "/v1/inference-providers", {
      method: "POST", body: JSON.stringify({
        name, providerId: "openrouter", modelIds: ["openai/gpt-4o-mini"],
        credential: { kind: "api_key", secret: upstreamKey }, allMembers: true,
        settings: { upstreamBaseUrl },
      }),
    });
    if (created.response.status !== 201) throw new Error(`Provider ${name} setup: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
    const id = usageString(usageRecord(usageRecord(created.body).inferenceProvider).id);
    const connect = await seed.api(member, `/v1/inference-providers/${id}/connect`);
    if (!connect.response.ok) throw new Error(`Member connect ${name}: HTTP ${connect.response.status}`);
    const connected = usageRecord(usageRecord(connect.body).inferenceProvider);
    const baseUrl = usageString(usageRecord(connected.providerConfig).api);
    if (new URL(baseUrl).origin !== new URL(gatewayUrl).origin) throw new Error("Gateway connect escaped the world's Gateway origin");
    return { id, name, apiKey: usageString(connected.apiKey), modelId: usageString(usageRecords(connected.models)[0]?.id), baseUrl };
  }
  const providerA = await provider("Provider A");
  const providerB = await provider("Provider B");
  await enableOrganizationCapabilities(seed, den.admin, { gatewayProviderUsageLimits: true }, orgId);

  // Default limit: $1 a month for everyone. The journey adds the Provider A limit in Den.
  const created = await seed.api(den.admin, "/v1/gateway/usage-limit-policies", {
    method: "POST", body: JSON.stringify({ name: "Everyone default", hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costUsd: "1" }] }),
  });
  if (created.response.status !== 200) throw new Error(`Default policy: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
  const defaultPolicyId = usageString(usageRecord(created.body).id);
  const assigned = await seed.api(den.admin, `/v1/gateway/usage-limit-policies/${defaultPolicyId}/assignments`, { method: "POST", body: JSON.stringify({ organization: true }) });
  if (assigned.response.status !== 200) throw new Error(`Default policy assignment: HTTP ${assigned.response.status} ${assigned.text.slice(0, 300)}`);

  const web = await seed.web({
    den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway?tab=limits", headless: true,
    viewport: { width: 1440, height: 1100, deviceScaleFactor: 1 },
  });
  // The member's app in headless Chrome, signed in to the same Den.
  const { app } = await signedInAppWeb(seed, { name: "provider-usage-member", den, webPort, as: "member", workspacePath: seed.tmpPath("provider-usage-member") });

  const resources = setup.move();
  return {
    den, web, app, member, orgId, memberId, providerA, providerB, defaultPolicyId,
    placement: place.kind,
    /** Calls the upstream has received, as its own witness log records them. */
    upstreamCount: () => upstreamRequests(),
    /** One chat completion through the Gateway to a provider, as any client would send it. */
    async generate(target: typeof providerA) {
      const response = await fetch(`${target.baseUrl}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${target.apiKey}` },
        body: JSON.stringify({ model: target.modelId, stream: false, max_tokens: 32, messages: [{ role: "user", content: "Provider limit witness" }] }),
        signal: AbortSignal.timeout(30_000),
      });
      const body: unknown = await response.json();
      return { status: response.status, body, errorCode: response.headers.get("x-openwork-error-code") };
    },
    async setProviderLimits(enabled: boolean) {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${orgId}/capabilities`, {
        method: "PUT", body: JSON.stringify({ capabilities: { gatewayProviderUsageLimits: enabled } }),
      });
      if (!result.response.ok) throw new Error(`Setting provider limits ${enabled}: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
    },
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}
