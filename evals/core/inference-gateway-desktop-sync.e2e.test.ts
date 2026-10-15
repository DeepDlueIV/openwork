import { expect } from "vitest";
import { gatewayProviders, gatewayRecord, gatewayRecords } from "@openwork/behaviors";
import { spec } from "@openwork/testkit";
import { organizationGatewayModel } from "../worlds/providers-before-workspace.ts";

// An owner shares one AI Gateway provider with everyone and another with
// nobody. The member's desktop offers only the shared model, badged "via
// OpenWork Gateway", and it answers through the real Gateway, which alone
// holds the upstream key. When the owner stops sharing it, it leaves the
// member's Den and desktop. Den, the Gateway and the desktop are real; the
// upstream is a deterministic streaming model.
const test = spec.world(organizationGatewayModel, {
  timeout: 900_000,
  resources: {
    surfaces: ["desktop"],
    services: ["den", "mock"],
    nativeReason: "The desktop's local server syncs the organization's Gateway providers into its engine; the picker and the answer come from that engine.",
  },
  needs: { placement: "local", commands: ["pnpm"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
});

const GATEWAY_KEY = /^ow_gw_[A-Za-z0-9_-]{43}$/;

test("a gateway model an owner shares appears on a member's desktop picker and answers", async ({ world, user, probe, step }) => {
  const usable = async () => gatewayProviders((await probe.api(world.member, "/v1/inference-providers")).body).map((entry) => entry.id);
  const synced = async () => gatewayRecords(gatewayRecord((await probe.desktopApi("/cloud-provider-sync/status")).body).providers);

  const model = await step("before: the member can use the shared provider, not the one shared with nobody, and Den never hands out the upstream key", async () => {
    const ids = await usable();
    expect(ids).toContain(world.providerId);
    expect(ids).not.toContain(world.restrictedProviderId);
    const connect = await probe.api(world.member, `/v1/inference-providers/${world.providerId}/connect`);
    expect(connect.response.status).toBe(200);
    const provider = gatewayRecord(gatewayRecord(connect.body).inferenceProvider);
    expect(String(provider.apiKey)).toMatch(GATEWAY_KEY);
    expect(connect.text).not.toContain(world.upstreamSecret);
    const restricted = await probe.api(world.member, `/v1/inference-providers/${world.restrictedProviderId}/connect`);
    expect(restricted.response.status).toBe(403);
    const first = gatewayRecords(provider.models)[0];
    if (typeof first?.id !== "string" || typeof first.name !== "string") throw new Error("The shared provider has no model");
    return { id: first.id, name: first.name };
  });

  await step("the desktop picker lists the Gateway model under its provider, badged via OpenWork Gateway, and not the restricted one", async () => {
    await user.see("composer", { editable: true, timeoutMs: 180_000 });
    const rows = await probe.eventually(synced, {
      within: 180_000, label: "the desktop syncs the shared Gateway provider",
      until: (entries) => entries.some((entry) => entry.cloudProviderId === world.providerId),
    });
    expect(rows.find((entry) => entry.cloudProviderId === world.providerId)).toMatchObject({ source: "openwork_gateway" });
    expect(rows.some((entry) => entry.cloudProviderId === world.restrictedProviderId)).toBe(false);
    await user.click({ role: "button", label: "Change model" });
    await user.see({ text: world.providerName }, { timeoutMs: 60_000 });
    await user.see({ text: "via OpenWork Gateway" });
    await user.notSee({ text: "Restricted Gateway" });
    await user.screenshot();
    await user.click({ testId: `model-option-${world.providerId}-${model.id}` });
    await user.see({ role: "button", label: "Change model" }, { text: model.name, timeoutMs: 30_000 });
  });

  await step("after: the member's message is answered through the Gateway, which alone uses the organization's upstream key", async () => {
    const before = world.upstreamRequests().length;
    await user.type("composer", "hello");
    await user.press("Enter");
    await user.see({ text: world.reply }, { timeoutMs: 120_000 });
    await user.notSee({ text: /ProviderModelNotFoundError|Model not found/ });
    const requests = world.upstreamRequests().slice(before);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.credential === `Bearer ${world.upstreamSecret}` && request.model === "openai/gpt-4o-mini")).toBe(true);
    await user.screenshot();
  });

  await step("after: when the owner stops sharing the provider, it leaves the member's Den and desktop", async () => {
    const grants = gatewayRecords(gatewayRecord((await probe.api(world.den.admin, `/v1/inference-providers/${world.providerId}/access-grants`)).body).accessGrants);
    for (const grant of grants) {
      const removed = await probe.api(world.den.admin, `/v1/inference-providers/${world.providerId}/access-grants/${String(grant.id)}`, { method: "DELETE" });
      expect(removed.response.status).toBe(204);
    }
    expect(await usable()).not.toContain(world.providerId);
    expect((await probe.api(world.member, `/v1/inference-providers/${world.providerId}/connect`)).response.status).toBe(403);
    const rows = await probe.eventually(synced, {
      within: 180_000, label: "the desktop drops the revoked Gateway provider",
      until: (entries) => !entries.some((entry) => entry.cloudProviderId === world.providerId),
    });
    expect(rows.some((entry) => entry.cloudProviderId === world.providerId)).toBe(false);
  });
});
