import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { gatewayErrorDetails, gatewayRecord, gatewayRecords, gatewayUsageUsed } from "@openwork/behaviors";
import { gatewayUsageLimitPolicySchema, gatewayUsageStatusSchema } from "@openwork/types/den/gateway-usage-limits";
import { aiGatewaySpendLimitsEnforced } from "../worlds/ai-gateway-spend-limits.ts";

// The Gateway enforces the limits an owner sets in Den: a member is paused at
// the default limit, a provider limit of their own is counted separately, and
// a paused member can ask for more. Den, the Gateway and the app are real; the
// upstream is a deterministic local model that reports $1 per call.
const test = spec.world(aiGatewaySpendLimitsEnforced, {
  timeout: 600_000,
  resources: { surfaces: ["web", "appWeb"], services: ["den", "mock"] },
  needs: { commands: ["pnpm"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
});

const DOLLAR = 1_000_000;
const requestsPath = "/v1/gateway/usage-limit-reset-requests";
const used = gatewayUsageUsed;
const errorDetails = gatewayErrorDetails;

test("an admin gives a member their own Provider A limit: Provider A keeps working after the default runs out, and only its own limit pauses it", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const member = user.on(world.app);
  const limitsUrl = `${world.den.ref.webUrl}/dashboard/ai-gateway?tab=limits`;
  const providerPolicyId = () => policies().then((rows) => rows.find((row) => row.providerId === world.providerA.id)?.id);
  const policies = async () => {
    const result = await probe.api(world.den.admin, "/v1/gateway/usage-limit-policies");
    expect(result.response.status).toBe(200);
    return gatewayRecords(gatewayRecord(result.body).policies).map((row) => gatewayUsageLimitPolicySchema.parse(row));
  };
  const own = async () => {
    const result = await probe.api(world.member, "/v1/gateway/usage-limits/me");
    expect(result.response.status).toBe(200);
    return gatewayUsageStatusSchema.parse(result.body);
  };
  const settledTo = (expected: Partial<ReturnType<typeof used>>, label: string) => eventually(own, {
    within: 30_000, label,
    until: (status) => Object.entries(expected).every(([key, value]) => Reflect.get(used(status), key) === value),
  });

  await step("before: the organization has one $1 monthly default limit for everyone", async () => {
    await admin.navigate(limitsUrl);
    await admin.see({ testId: "gateway-limit-row" }, { text: /\$1\.00 a month each/, timeoutMs: 90_000 });
    await admin.see({ testId: "gateway-limit-provider-label" }, { text: "All providers" });
    const observed = used(await own());
    evidence.recordAssertionEvidence("member's limits before the provider limit", `${JSON.stringify(observed)} (Den and Gateway placement: ${world.placement})`, observed.providerName === null);
    expect(observed).toEqual({ defaultUsed: 0, defaultState: "within_limit", providerName: null, providerUsed: null, providerState: null });
    await admin.screenshot();
  });

  await step("the admin adds a $2 monthly limit only for Provider A, for the member", async () => {
    await admin.click({ testId: "gateway-limit-new" });
    await admin.see({ testId: "gateway-limit-provider" }, { timeoutMs: 30_000 });
    await admin.click({ role: "combobox", label: "Provider" });
    await admin.click({ role: "option", label: /Provider A/ });
    await admin.click({ role: "switch", label: "Everyone in the organization" });
    await admin.click({ testId: "gateway-limit-add-person" });
    await admin.click({ role: "combobox", label: "Person" });
    await admin.click({ role: "option", label: /Limits Member/ });
    await admin.type({ testId: "gateway-limit-amount-month" }, "2");
    await admin.see({ testId: "gateway-limit-provider" }, { text: /stop counting this provider toward the default limit/ });
    await admin.see({ role: "combobox", label: "Provider" }, { value: "Provider A" });
    await admin.screenshot();
    await admin.click({ testId: "gateway-limit-save" });
    await admin.see({ text: "Provider A" }, { timeoutMs: 30_000 });
    const saved = (await policies()).find((row) => row.providerId === world.providerA.id);
    evidence.recordAssertionEvidence("saved provider limit", JSON.stringify({ providerId: saved?.providerId, limits: saved?.limits, assignments: saved?.assignments.map((row) => row.memberId) }), Boolean(saved));
    expect(saved).toMatchObject({ limits: [{ timeframe: "month", costLimitMicroUsd: 2 * DOLLAR }], assignments: [{ memberId: world.memberId, teamId: null, organization: false }] });
    const observed = used(await own());
    expect(observed).toEqual({ defaultUsed: 0, defaultState: "within_limit", providerName: "Provider A", providerUsed: 0, providerState: "within_limit" });
    await admin.screenshot();
  });

  await step("after: the member's account menu shows the default and Provider A as separate limits", async () => {
    await member.click({ role: "button", label: "Account menu" });
    await member.see({ testId: "gateway-usage-menu-default" }, { text: /Default[\s\S]*This month[\s\S]*100% left/, timeoutMs: 60_000 });
    await member.see({ testId: "gateway-usage-menu-provider" }, { text: /Provider A[\s\S]*This month[\s\S]*100% left/ });
    await member.screenshot();
  });

  await step("the member's usage page lists the same two limits", async () => {
    await member.click({ testId: "gateway-usage-menu-item" });
    await member.see({ testId: "gateway-usage-default-limit" }, { text: /Default[\s\S]*For providers without their own limit[\s\S]*\$1\.00 of \$1\.00 left/, timeoutMs: 30_000 });
    await member.see({ testId: "gateway-usage-provider-limit" }, { text: /Provider A[\s\S]*Only Provider A models count here[\s\S]*\$2\.00 of \$2\.00 left/ });
    await member.screenshot();
  });

  await step("when the member uses Provider B, its $1 counts toward the default limit only", async () => {
    const before = await world.upstreamCount();
    const response = await world.generate(world.providerB);
    expect(response.status).toBe(200);
    // Witness: the request really reached the upstream that reports the $1.
    expect(await world.upstreamCount()).toBe(before + 1);
    const status = await settledTo({ defaultUsed: DOLLAR, providerUsed: 0 }, "Provider B spend settles into the default limit");
    evidence.recordAssertionEvidence("after one Provider B request", JSON.stringify(used(status)), used(status).providerUsed === 0);
    expect(used(status)).toMatchObject({ defaultState: "blocked", providerState: "within_limit" });
  });

  await step("then Provider B is paused by the default limit, without reaching the provider", async () => {
    const before = await world.upstreamCount();
    const response = await world.generate(world.providerB);
    const error = errorDetails(response.body);
    evidence.recordAssertionEvidence("second Provider B request", `HTTP ${response.status} ${String(error.code)}; provider detail ${JSON.stringify(error.details.provider ?? null)}`, response.status === 429);
    expect(response.status).toBe(429);
    expect(error.code).toBe("openwork_gateway_usage_limit_exceeded");
    expect(error.details.provider).toBeUndefined();
    expect(await world.upstreamCount()).toBe(before);
  });

  await step("after: Provider A still works with the default used up, and its cost counts only toward Provider A", async () => {
    const response = await world.generate(world.providerA);
    expect(response.status).toBe(200);
    const status = await settledTo({ providerUsed: DOLLAR }, "Provider A spend settles into the Provider A limit");
    evidence.recordAssertionEvidence("after one Provider A request", JSON.stringify(used(status)), used(status).defaultUsed === DOLLAR);
    expect(used(status)).toMatchObject({ defaultUsed: DOLLAR, providerState: "within_limit" });
  });

  await step("when Provider A reaches its own limit, the next request is paused and names Provider A", async () => {
    expect((await world.generate(world.providerA)).status).toBe(200);
    await settledTo({ providerUsed: 2 * DOLLAR, providerState: "blocked" }, "second Provider A request settles");
    const before = await world.upstreamCount();
    const response = await world.generate(world.providerA);
    const error = errorDetails(response.body);
    evidence.recordAssertionEvidence("third Provider A request", `HTTP ${response.status}: ${String(error.message)}`, response.status === 429);
    expect(response.status).toBe(429);
    expect(error.details.provider).toEqual({ id: world.providerA.id, name: "Provider A" });
    expect(String(error.message)).toContain("Provider A");
    expect(await world.upstreamCount()).toBe(before);
    expect(used(await own()).defaultUsed).toBe(DOLLAR);
  });

  await step("after: the member's page in Den shows the default limit and the Provider A limit separately", async () => {
    await admin.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway/people/${world.memberId}`);
    await admin.see({ testId: "gateway-person-provider-limit" }, { text: /Only Provider A[\s\S]*Paused[\s\S]*\$2\.00 used/, timeoutMs: 60_000 });
    await admin.see({ testId: "gateway-person-limit" }, { text: /Other providers[\s\S]*\$1\.00 used/ });
    await admin.screenshot();
  });

  await step("turning limits per provider off sends Provider A back to the default limit and keeps the provider limit", async () => {
    await world.setProviderLimits(false);
    const response = await eventually(() => world.generate(world.providerA), {
      within: 30_000, label: "the Gateway applies the default limit to Provider A",
      until: (value) => value.status === 429 && errorDetails(value.body).details.provider === undefined,
    });
    const status = await own();
    const policies = await probe.api(world.den.admin, "/v1/gateway/usage-limit-policies");
    const keptId = await providerPolicyId();
    const kept = gatewayRecords(gatewayRecord(policies.body).policies).map((row) => gatewayUsageLimitPolicySchema.parse(row)).find((row) => row.id === keptId);
    evidence.recordAssertionEvidence("Provider A request with limits per provider off", `HTTP ${response.status}, default limit; member sees ${status.providers?.length ?? 0} provider limits; stored limit kept for ${kept?.providerId ?? "none"}`, Boolean(kept));
    expect(status.providers ?? []).toEqual([]);
    expect(kept?.providerId).toBe(world.providerA.id);
  });

  await step("turning it back on restores what Provider A had already used", async () => {
    await world.setProviderLimits(true);
    const status = await settledTo({ providerUsed: 2 * DOLLAR, providerState: "blocked", defaultUsed: DOLLAR }, "provider limit returns with its usage");
    evidence.recordAssertionEvidence("limits per provider back on", JSON.stringify(used(status)), used(status).providerUsed === 2 * DOLLAR);
    expect(used(status).providerName).toBe("Provider A");
  });

  await step("after: the member's usage page shows both limits used up, each on its own", async () => {
    await member.reload();
    await member.see({ testId: "gateway-usage-default-limit" }, { text: /\$0\.00 of \$1\.00 left/, timeoutMs: 60_000 });
    await member.see({ testId: "gateway-usage-provider-limit" }, { text: /Provider A[\s\S]*\$0\.00 of \$2\.00 left/ });
    await member.screenshot();
  });

  await step("a member can read only their own limits and cannot list, create or approve anyone's", async () => {
    const before = (await policies()).length;
    expect((await probe.api(world.member, "/v1/gateway/usage-limit-policies")).response.status).toBe(403);
    expect((await probe.api(world.member, requestsPath)).response.status).toBe(403);
    const created = await probe.api(world.member, "/v1/gateway/usage-limit-policies", { method: "POST", body: JSON.stringify({ name: "Unauthorized", limits: [{ timeframe: "month", costUsd: "100" }] }) });
    expect(created.response.status).toBe(403);
    expect(await policies()).toHaveLength(before);
  });

  await step("a member paused by the default limit asks for more, the admin approves it in Den, and their next request goes through", async () => {
    const reason = "Finish the synthetic limits review";
    const bucket = (await own()).buckets.find((entry) => entry.timeframe === "month");
    if (!bucket) throw new Error("The member's default limit is missing");
    const asked = await probe.api(world.member, requestsPath, { method: "POST", body: JSON.stringify({ bucketId: bucket.id, reason }) });
    expect(asked.response.ok).toBe(true);
    const id = gatewayRecord(asked.body).id;
    expect((await probe.api(world.member, `${requestsPath}/${String(id)}/approve`, { method: "POST" })).response.status).toBe(403);
    expect((await world.generate(world.providerB)).status).toBe(429);
    await admin.navigate(limitsUrl);
    await admin.see({ text: reason }, { timeoutMs: 60_000 });
    await admin.screenshot();
    await admin.click({ role: "button", label: "Approve 25% for Limits Member, 1 month" });
    await admin.see({ text: /Request approved/ }, { timeoutMs: 30_000 });
    const before = await world.upstreamCount();
    const response = await eventually(() => world.generate(world.providerB), {
      within: 30_000, label: "the Gateway admits Provider B after the approved increase", until: (value) => value.status === 200,
    });
    expect(response.status).toBe(200);
    expect(await world.upstreamCount()).toBe(before + 1);
  });
});
