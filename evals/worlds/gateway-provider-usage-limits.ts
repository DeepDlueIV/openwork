import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { allocateFreePort } from "@openwork/cdp";
import { localMysqlIsRunning, SkipError, type Place, type Seed } from "@openwork/env";
import { startInferenceWitness } from "@openwork/labs";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { usageRecord, usageRecords, usageString } from "./gateway-usage-policy.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const upstreamSecret = "gateway-provider-limits-upstream-only";

/**
 * Den + Gateway with two Gateway providers (A and B) on one deterministic
 * upstream that reports $1 per call, one member connected to both, and
 * per-provider usage limits turned on for the organization.
 */
export async function gatewayProviderUsageLimits(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("co-located Den, Gateway, MySQL and loopback upstream; this world cannot provision a remote Gateway");
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim() || process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim()) throw new Error("Provider usage journey requires a fresh testkit Den, never an attached service");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable openwork_eval_ database");
  await using setup = new AsyncDisposableStack();
  const witness = setup.use(await startInferenceWitness({ reportedCostUsd: 1 }));
  witness.mode("json");
  const port = await allocateFreePort();
  const gatewayUrl = `http://127.0.0.1:${port}`;
  const { den, webPort } = await denForAppWeb(seed, {
    web: true,
    schema: "migrate",
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql",
      DEN_ORG_MODE: "multi_org", DEN_PLAN_GATING_ENABLED: "false",
      GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl,
      GATEWAY_PUBLIC_BASE_URL: gatewayUrl, GATEWAY_EGRESS_ALLOWED_ORIGINS: new URL(witness.url).origin,
      PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
    },
    org: {
      name: `Provider Limits Journey ${Date.now()}`,
      admin: { name: "Limits Admin", email: "provider-limits-admin@example.test" },
      members: { member: { name: "Limits Member", email: "provider-limits-member@example.test" } },
    },
  });
  const databaseUrl = den.database?.url;
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("Expected testkit scratch database");
  const member = den.members.member;
  if (!member) throw new Error("Expected a synthetic member session");
  const orgResponse = await seed.api(den.admin, "/v1/org");
  if (!orgResponse.response.ok) throw new Error(`Org lookup: HTTP ${orgResponse.response.status}`);
  const org = usageRecord(orgResponse.body);
  const orgId = usageString(usageRecord(org.organization).id);
  const memberId = usageString(usageRecords(org.members).find((row) => usageRecord(row.user).email === member.email)?.id);

  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "src/server.ts"], {
    cwd: `${root}/ee/apps/gateway`, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", OPENWORK_DEV_MODE: "1",
      PORT: String(port), GATEWAY_PORT: String(port), GATEWAY_ENABLED: "true",
      DATABASE_URL: databaseUrl, DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
      GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl,
      GATEWAY_EGRESS_ALLOWED_ORIGINS: new URL(witness.url).origin,
      OPENROUTER_UPSTREAM_URL: witness.url, GATEWAY_WEBHOOK_SECRET: "provider-limits-webhook-only",
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

  async function provider(name: string) {
    const created = await seed.api(den.admin, "/v1/inference-providers", {
      method: "POST", body: JSON.stringify({
        name, providerId: "openrouter", modelIds: ["openai/gpt-4o-mini"],
        credential: { kind: "api_key", secret: upstreamSecret }, allMembers: true,
        settings: { upstreamBaseUrl: witness.url },
      }),
    });
    if (created.response.status !== 201) throw new Error(`Provider ${name} setup: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
    const id = usageString(usageRecord(usageRecord(created.body).inferenceProvider).id);
    const connect = await seed.api(member, `/v1/inference-providers/${id}/connect`);
    if (!connect.response.ok) throw new Error(`Member connect ${name}: HTTP ${connect.response.status}`);
    const connected = usageRecord(usageRecord(connect.body).inferenceProvider);
    const baseUrl = usageString(usageRecord(connected.providerConfig).api);
    if (new URL(baseUrl).origin !== gatewayUrl) throw new Error("Gateway connect escaped the owned loopback origin");
    return { id, name, apiKey: usageString(connected.apiKey), modelId: usageString(usageRecords(connected.models)[0]?.id), baseUrl };
  }
  const providerA = await provider("Provider A");
  const providerB = await provider("Provider B");
  await enableOrganizationCapabilities(seed, den.admin, { gatewayProviderUsageLimits: true }, orgId);

  // Default limit: $1 a month for everyone. The journey adds the Provider A limit in Den.
  async function policy(body: Record<string, unknown>, target: Record<string, unknown>) {
    const created = await seed.api(den.admin, "/v1/gateway/usage-limit-policies", { method: "POST", body: JSON.stringify(body) });
    if (created.response.status !== 200) throw new Error(`Policy ${String(body.name)}: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
    const id = usageString(usageRecord(created.body).id);
    const assigned = await seed.api(den.admin, `/v1/gateway/usage-limit-policies/${id}/assignments`, { method: "POST", body: JSON.stringify(target) });
    if (assigned.response.status !== 200) throw new Error(`Assign ${String(body.name)}: HTTP ${assigned.response.status} ${assigned.text.slice(0, 300)}`);
    return id;
  }
  const defaultPolicyId = await policy(
    { name: "Everyone default", hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costUsd: "1" }] },
    { organization: true },
  );
  const web = await seed.web({
    den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway?tab=limits", headless: true,
    viewport: { width: 1440, height: 1100, deviceScaleFactor: 1 },
  });

  // The member's app in headless Chrome, signed in to the same Den.
  const { app } = await signedInAppWeb(seed, { name: "provider-usage-member", den, webPort, as: "member", workspacePath: seed.tmpPath("provider-usage-member") });

  const resources = setup.move();
  return {
    den, web, app, member, orgId, memberId, providerA, providerB, defaultPolicyId,
    upstreamCount: () => witness.requests.length,
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
