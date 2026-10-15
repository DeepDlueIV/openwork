import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { analyticsSetupWorld, analyticsSurfaceWorld } from "../worlds/models-analytics.ts";

const test = spec.world(analyticsSurfaceWorld, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });
const setupTest = spec.world(analyticsSetupWorld, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner can hide analytics without losing existing export consent or granting another member access", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const headers = { "x-openwork-org-id": world.orgId, authorization: `Bearer ${world.den.admin.token}` };
  const base = world.den.ref.webUrl;
  const api = (path: string) => probe.api(world.den.admin, `/v1/inference/analytics/${path}`, { headers });
  const guarded = ["usage?modelsAnalyticsUi=true", "settings?taskAnalyticsUi=true", "activity?days=30&taskAnalyticsUi=true", "consumption?days=30&memberId=not-a-member"];

  await step("before: analytics is hidden by default and direct links return to usage and adoption", async () => {
    await owner.see({ role: "heading", label: "Usage & adoption" }, { timeoutMs: 90_000 });
    await owner.notSee({ role: "link", label: "Models & usage" });
    await owner.navigate(`${base}/dashboard/analytics/models`);
    await owner.see({ role: "heading", label: "Usage & adoption" }, { timeoutMs: 60_000 });
    await owner.notSee({ text: "Task analytics" });
    for (const path of guarded) expect((await api(path)).response.status, path).toBe(404);
    for (const [method, path, body] of [
      ["PATCH", "settings", { enabled: false, consentVersion: 1 }],
      ["POST", "langfuse/test", { host: "https://analytics.example.com", publicKey: "synthetic-public", secretKey: "synthetic-secret" }],
      ["POST", "langfuse/connect", { host: "https://analytics.example.com", publicKey: "synthetic-public", secretKey: "synthetic-secret" }],
      ["DELETE", "langfuse", undefined],
    ] as const) {
      const response = await world.requestAnalytics(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(response.response.status, `${method} ${path}`).toBe(404);
    }
    const memberSettings = await probe.api(world.den.members.teammate, "/v1/inference/analytics/settings?taskAnalyticsUi=true", {
      headers: { ...headers, authorization: `Bearer ${world.den.members.teammate.token}` },
    });
    expect(memberSettings.response.status).toBe(404);
    await world.arrange("assert-surface-retained");
    evidence.recordAssertionEvidence("hidden surfaces deny dashboard and configuration APIs without modifying exports", "Four reads and four configuration requests return 404; direct URL returns to Usage & adoption; encrypted export configuration and consent are retained.", true);
    await owner.screenshot();
  });

  await step("the Models rollout restores the usage tab without exposing task analytics", async () => {
    await world.flags(true, false);
    await owner.reload();
    await owner.click({ role: "link", label: "Models & usage" });
    await owner.see({ role: "heading", label: "Models & usage" }, { timeoutMs: 60_000 });
    await owner.notSee({ text: "Task analytics" });
    expect((await api("usage")).response.status).toBe(200);
    expect((await api("settings")).response.status).toBe(404);
    evidence.recordAssertionEvidence("the two surface switches are independent", "Models usage answers 200 and its tab is visible; task analytics stays absent and settings answer 404.", true);
    await owner.screenshot();
  });

  await step("after: enabling task analytics restores Activity, Consumption and the retained Langfuse connection", async () => {
    await world.flags(true, true);
    await owner.reload();
    await owner.see({ role: "heading", label: "Task analytics" }, { timeoutMs: 60_000 });
    await owner.see({ text: "Analytics on" });
    await owner.see({ role: "button", label: "Turn off analytics" });
    await owner.click({ role: "tab", label: "Consumption" });
    await owner.see({ role: "tab", label: "Integrations" });
    const settings = await api("settings");
    expect(settings.response.status).toBe(200);
    expect(settings.text).not.toContain("synthetic-secret-key");
    expect(settings.text).not.toContain("synthetic-public-key");
    const activity = await api("activity?days=30");
    expect(activity.response.status).toBe(200);
    expect(activity.body).toMatchObject({ events: [{ id: "retained-surface-event" }] });
    expect((await api("consumption?days=30")).response.status).toBe(200);
    evidence.recordAssertionEvidence("opted-in analytics returns without exposing saved keys", "Settings, activity and consumption return 200; the existing task event is retained, neither saved key appears in the response, and all three task tabs are present.", true);
    await owner.screenshot();
  });

  await step("the owner can inspect the existing export but an ordinary member and another organization cannot read analytics", async () => {
    await owner.click({ role: "tab", label: "Integrations" });
    await owner.see({ text: /^Connected$/ });
    await owner.see({ role: "button", label: "Disconnect Langfuse" });
    const member = world.den.members.teammate;
    const forbidden = await probe.api(member, "/v1/inference/analytics/activity?days=30", { headers: { ...headers, authorization: `Bearer ${member.token}` } });
    expect(forbidden.response.status).toBe(403);
    const other = await probe.api(world.outsider.admin, "/v1/inference/analytics/settings", { headers: { ...headers, authorization: `Bearer ${world.outsider.admin.token}` } });
    expect(other.response.status).toBe(404);
    await world.arrange("assert-surface-retained");
    evidence.recordAssertionEvidence("surface rollout never grants analytics permissions or cross-organization access", "An ordinary member's activity returns 403 and an outsider's settings request is masked as 404; saved export credentials and consent remain unchanged.", true);
    await owner.screenshot();
  });

  await step("turning both surfaces off again leaves existing collection and exports intact", async () => {
    await world.flags(false, false);
    await owner.reload();
    await owner.see({ role: "heading", label: "Usage & adoption" }, { timeoutMs: 60_000 });
    await owner.notSee({ role: "link", label: "Models & usage" });
    await owner.notSee({ text: "Langfuse" });
    await world.arrange("assert-surface-retained");
    expect((await api("settings")).response.status).toBe(404);
    // Runtime event ingestion is not a user-facing configuration/read endpoint.
    const ingestion = await world.requestAnalytics("events", { method: "POST", body: JSON.stringify({ events: [] }) });
    expect(ingestion.response.status).not.toBe(404);
    evidence.recordAssertionEvidence("hiding analytics is reversible and does not turn off collection", "The tabs disappear again, reads return 404, runtime ingestion is not feature-disabled, and task history, its export receipt, consent cutoff and encrypted export configuration are unchanged.", true);
    await owner.screenshot();
  });
});

setupTest("an owner sees Langfuse setup only after both analytics surfaces are enabled", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  await step("before: the default-off workspace has no Models or Langfuse entry point", async () => {
    await owner.see({ role: "heading", label: "Usage & adoption" }, { timeoutMs: 90_000 });
    await owner.notSee({ role: "link", label: "Models & usage" });
    await owner.click({ testId: "den-command-palette-trigger" });
    await owner.see({ testId: "den-command-palette-input" });
    await owner.see({ role: "option", label: /^Analytics/ });
    await owner.notSee({ role: "option", label: /Models & usage|Task analytics|Langfuse/ });
    evidence.recordAssertionEvidence("hidden analytics does not leak a palette shortcut", "The palette retains Analytics for Usage & adoption, with no Models & usage, Task analytics or Langfuse entry while the flags are off.", true);
    await owner.screenshot();
    await owner.press("Escape");
  });
  await step("after: the opted-in owner can choose a data region and enter project credentials", async () => {
    await world.flags(true, true);
    await owner.reload();
    await owner.click({ role: "link", label: "Models & usage" });
    await owner.see({ role: "heading", label: "Task analytics" }, { timeoutMs: 60_000 });
    await owner.click({ role: "tab", label: "Integrations" });
    await owner.see({ label: "Data region" });
    await owner.see({ label: "Public key" });
    await owner.see({ label: "Secret key" });
    await owner.type({ label: "Public key" }, "synthetic-public-unused");
    await owner.type({ label: "Secret key" }, "synthetic-secret-unused", { sensitive: true });
    await owner.see({ role: "button", label: "Test connection" });
    await owner.see({ role: "button", label: "Connect Langfuse" });
    const secret = (await probe.on(world.web).dom('input[type="password"]')).elements;
    expect(secret).toHaveLength(1);
    evidence.recordAssertionEvidence("the restored integration form keeps secrets masked", "Data region, project key fields, Test connection and Connect Langfuse are present; the secret field is a password input. No external destination is contacted.", true);
    await owner.screenshot();
  });
  await step("turning the surface off removes the setup controls and leaves Usage and adoption available", async () => {
    await world.flags(false, false);
    await owner.reload();
    await owner.see({ role: "heading", label: "Usage & adoption" }, { timeoutMs: 60_000 });
    await owner.notSee({ label: "Secret key" });
    await owner.notSee({ role: "button", label: "Connect Langfuse" });
    evidence.recordAssertionEvidence("setup is hidden without removing the remaining analytics", "Usage & adoption is still available, while Langfuse setup and the Models tab are absent.", true);
    await owner.screenshot();
  });
});
