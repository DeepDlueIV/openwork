import type { Seed } from "@openwork/env";
import { denFetch, freshSession } from "@openwork/behaviors";
import { healthFixture } from "./den-service-readiness.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
function memberId(body: unknown): string {
  const id = field(field(body, "currentMember"), "id");
  if (typeof id !== "string") throw new Error("Missing genuine organization membership");
  return id;
}

export function localSettingsServices(seed: Seed) { return settingsServices(seed, "self_hosted"); }
export function cloudSettingsServices(seed: Seed) { return settingsServices(seed, "cloud"); }

/** Real sessions, membership, ownership transfer, feature store and UI; only external health is mocked. */
async function settingsServices(seed: Seed, deployment: "cloud" | "self_hosted") {
  const stack = new AsyncDisposableStack();
  try {
    const fixture = stack.use(await healthFixture());
    const den = await seed.den({
      org: {
        name: "Service settings",
        admin: { name: "Installation Operator" },
        members: { owner: { name: "Organization Owner" }, member: { name: "Workspace Member" } },
      },
      env: {
        DEN_DEPLOYMENT: deployment, DEN_FEATURE_SERVICE_READINESS: "true",
        GATEWAY_ENABLED: "false", GATEWAY_PROXY_BASE_URL: "", GATEWAY_PUBLIC_BASE_URL: "",
        DEN_HEADLESS_RUNNER_URL: fixture.url,
        DEN_HEADLESS_RUNNER_TOKEN: "readiness-fixture-service-token-not-production",
        DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "", DEN_WORKBOT_URL: "",
        SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", SMTP_PORT: "", SMTP_SECURE: "", RESEND_API_KEY: "", EMAIL_FROM: "",
      },
    });
    const rollout = await seed.api(den.admin, "/v1/admin/features/serviceReadiness", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    if (!rollout.response.ok) throw new Error(`Cannot enable disposable readiness rollout: ${rollout.response.status}`);
    const operatorContext = await seed.api(den.admin, "/v1/org");
    const ownerContext = await seed.api(den.members.owner, "/v1/org");
    const operatorId = memberId(operatorContext.body), ownerId = memberId(ownerContext.body);
    const promote = await seed.api(den.admin, `/v1/members/${ownerId}/role`, { method: "POST", body: JSON.stringify({ role: "admin" }) });
    if (!promote.response.ok) throw new Error(`Real admin promotion failed: ${promote.response.status}`);
    const transfer = await seed.api(den.admin, `/v1/members/${ownerId}/transfer-ownership`, { method: "POST" });
    if (!transfer.response.ok) throw new Error(`Real ownership transfer failed: ${transfer.response.status}`);
    // Role changes revoke sessions. Sign in again rather than bypassing that boundary.
    den.members.owner = await freshSession(den.members.owner);
    const demote = await seed.api(den.members.owner, `/v1/members/${operatorId}/role`, { method: "POST", body: JSON.stringify({ role: "member" }) });
    if (!demote.response.ok) throw new Error(`Real operator role change failed: ${demote.response.status}`);
    den.admin = await freshSession(den.admin);
    // Return ownership before the framework deletes this disposable organization.
    stack.defer(async () => {
      const owner = await freshSession(den.members.owner);
      const headers = { authorization: `Bearer ${owner.token}` };
      const promote = await denFetch(owner, `/v1/members/${operatorId}/role`, { method: "POST", headers, body: JSON.stringify({ role: "admin" }) });
      if (!promote.response.ok) throw new Error(`Cleanup promotion failed: ${promote.response.status}`);
      const transfer = await denFetch(owner, `/v1/members/${operatorId}/transfer-ownership`, { method: "POST", headers });
      if (!transfer.response.ok) throw new Error(`Cleanup ownership transfer failed: ${transfer.response.status}`);
    });
    const viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
    const operator = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard", headless: true, viewport });
    const owner = await seed.web({ den, signedInAs: den.members.owner, startPath: "/dashboard", headless: true, viewport });
    const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/dashboard", headless: true, viewport });
    return { den, operator, owner, member, fixtureCalls: fixture.calls, unexpectedFixtureCalls: fixture.unexpected, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
