import { allocateFreePort } from "@openwork/cdp";
import { localMysqlIsRunning, SkipError, type Place, type Seed } from "@openwork/env";
import { startInferenceWitness } from "@openwork/labs";
import { startLocalGatewayProcess } from "./infra.ts";
import { isRecord } from "./library.ts";

type OrganizationProviderOptions = {
  label: string;
  providerName: string;
  modelName: string;
  /** Deterministic model witness the organization provider points at. */
  mock?: ReturnType<Seed["mock"]>;
  /** Extra organization models besides `pilot-model` (default: none). */
  extraModels?: { id: string; name: string }[];
};

async function signedInBeforeFirstWorkspace(seed: Seed, options: OrganizationProviderOptions) {
  const organizationName = `${options.label} ${Date.now()}`;
  const den = await seed.den({
    org: {
      name: organizationName,
      admin: { name: "Pilot Admin" },
      members: { member: { name: "Pilot Member" } },
    },
    ...(options.mock ? { mocks: { agent: options.mock } } : {}),
  });
  const member = den.members.member;
  if (!member) throw new Error("seed.den() did not provision the pilot member session");
  const agent = options.mock ? den.mocks.agent : undefined;
  if (options.mock && !agent) throw new Error("seed.den() did not boot the model witness");

  const created = await seed.api(den.admin, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: options.providerName,
      source: "custom",
      customConfig: {
        id: "pilot-inference",
        name: options.providerName,
        npm: "@ai-sdk/openai-compatible",
        api: agent ? `${agent.url}/v1` : "https://inference.eval.invalid/v1",
        env: ["PILOT_INFERENCE_API_KEY"],
        models: [{ id: "pilot-model", name: options.modelName }, ...(options.extraModels ?? [])],
      },
      apiKey: "sk-pilot-inference-eval-only",
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const llmProvider = isRecord(created.body) && isRecord(created.body.llmProvider) ? created.body.llmProvider : null;
  if (created.response.status !== 201 || typeof llmProvider?.id !== "string") {
    throw new Error(`Organization provider setup failed: HTTP ${created.response.status}`);
  }

  const app = await seed.desktop({ den, as: "member", workspace: false, name: "providers-before-workspace" });
  return {
    den,
    member,
    app,
    organizationName,
    providerName: options.providerName,
    modelName: options.modelName,
    providerId: llmProvider.id,
    firstWorkspacePath: seed.tmpPath("first-workspace"),
  };
}

/**
 * An organization member who signs in on a managed desktop before creating
 * any workspace, with one organization LLM provider assigned to them. The
 * installation carries a Den bootstrap, so the desktop does not create its
 * public first-launch folder: the member really has zero workspaces.
 */
export async function providersBeforeFirstWorkspace(seed: Seed) {
  return signedInBeforeFirstWorkspace(seed, {
    label: "Providers before workspace",
    providerName: "Pilot inference",
    modelName: "Pilot model",
  });
}

export const ORGANIZATION_MODEL_REPLY = "ORG-MODEL-FIRST-MESSAGE-REPLY-OK";

/**
 * The same member, but the organization provider serves a deterministic model
 * that answers any prompt, so the first message typed before any workspace
 * exists can be answered end to end.
 */
export async function organizationModelBeforeFirstWorkspace(seed: Seed) {
  const mock = seed.mock({ agentWorkloads: [{ promptMarker: "hello", matchAll: true, finalReply: ORGANIZATION_MODEL_REPLY, steps: [] }] });
  const world = await signedInBeforeFirstWorkspace(seed, {
    label: "Organization model before workspace",
    providerName: "Pilot inference",
    modelName: "Pilot model",
    mock,
    extraModels: [{ id: "pilot-model-b", name: "Pilot model B" }],
  });
  return { ...world, reply: ORGANIZATION_MODEL_REPLY, secondModel: { id: "pilot-model-b", name: "Pilot model B" } };
}

const GATEWAY_UPSTREAM_SECRET = "sk-gateway-upstream-never-reaches-a-device";

/**
 * Option of this world for the AI Gateway: the organization's model comes
 * through OpenWork's Gateway instead of the organization's own provider. Den
 * and the real Gateway run next to a scratch MySQL database, the Gateway
 * forwards to a deterministic streaming upstream that answers "Complete café",
 * and the owner has shared one Gateway provider with everyone and a second one
 * with nobody. The member signs in on a managed desktop. Local only.
 */
export async function organizationGatewayModel(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("co-located Den, Gateway, MySQL and loopback upstream");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable openwork_eval_ database");
  await using setup = new AsyncDisposableStack();
  const upstream = setup.use(await startInferenceWitness());
  upstream.mode("success");
  const port = await allocateFreePort();
  const gatewayUrl = `http://127.0.0.1:${port}`;
  const den = await seed.den({
    schema: "migrate",
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DEN_ORG_MODE: "multi_org", DEN_PLAN_GATING_ENABLED: "false",
      GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl,
      GATEWAY_EGRESS_ALLOWED_ORIGINS: new URL(upstream.url).origin,
      PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
    },
    org: {
      name: `Gateway reaches members ${Date.now()}`,
      admin: { name: "Gateway Owner" },
      members: { member: { name: "Gateway Member" } },
    },
  });
  const member = den.members.member;
  const databaseUrl = den.database?.url;
  if (!member || !databaseUrl) throw new Error("seed.den() did not provision the member and a scratch database");
  setup.use(await startLocalGatewayProcess({ port, databaseUrl, allowedOrigin: new URL(upstream.url).origin }));
  const provider = async (name: string, allMembers: boolean) => {
    const created = await seed.api(den.admin, "/v1/inference-providers", {
      method: "POST", body: JSON.stringify({
        name, providerId: "openrouter", modelIds: ["openai/gpt-4o-mini"], allMembers,
        credential: { kind: "api_key", secret: GATEWAY_UPSTREAM_SECRET }, settings: { upstreamBaseUrl: upstream.url },
      }),
    });
    const row = isRecord(created.body) && isRecord(created.body.inferenceProvider) ? created.body.inferenceProvider : null;
    if (created.response.status !== 201 || typeof row?.id !== "string") throw new Error(`Gateway provider ${name}: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
    return row.id;
  };
  const providerId = await provider("Acme Gateway", true);
  const restrictedProviderId = await provider("Restricted Gateway", false);
  // Re-read the organization's providers every few seconds, so revoked access leaves the desktop within the journey.
  const app = await seed.desktop({ den, as: "member", name: "gateway-reaches-members", env: { OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "5000" } });
  const resources = setup.move();
  return {
    den, member, app, providerId, restrictedProviderId,
    providerName: "Acme Gateway", upstreamSecret: GATEWAY_UPSTREAM_SECRET, reply: "Complete café",
    /** Requests the upstream received, as its own witness log records them. */
    upstreamRequests: () => upstream.requests.map((request) => ({ credential: request.credential, model: request.body.model })),
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}
