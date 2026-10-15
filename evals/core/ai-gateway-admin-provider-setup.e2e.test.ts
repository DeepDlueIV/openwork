import { expect } from "vitest";
import { gatewayFirstCredentialSet, gatewayProviders as providers, gatewayRecord } from "@openwork/behaviors";
import { spec } from "@openwork/testkit";
import { aiGatewayCatalogStates } from "../worlds/ai-gateway-catalog-states.ts";

// An owner sets up providers that need more than one shared key, while the
// provider catalog and model reads are slow, failing or empty: LiteLLM, and
// Amazon Bedrock and Microsoft Foundry where each person signs in themselves.
// Den is real; catalog reads are faulted in the owner's browser, and nothing
// reaches AWS, Microsoft or the gateway.
const test = spec.world((seed, context) => aiGatewayCatalogStates(seed, context, { teammatePasswordSession: true }), {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

// Placeholder IAM Identity Center values: Den stores them without calling AWS.
const AWS_SSO = { startUrl: "https://d-9067eval00.awsapps.com/start", region: "us-east-1", accountId: "123456789012", roleName: "BedrockInference" };

test("an owner recovers slow, failed and empty catalogs, sets up LiteLLM and per-person cloud sign-in, and a teammate still cannot open the editor", async ({
  world, user, probe, step, evidence,
}) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const addProvider = `${world.den.ref.webUrl}/dashboard/ai-gateway/providers/new`;

  await step("before: a failed provider catalog offers Retry instead of claiming there are no providers", async () => {
    await owner.see({ testId: "gateway-providers-empty" }, { timeoutMs: 90_000 });
    await world.catalogFaults.fail("catalog");
    await owner.click({ role: "link", label: "Add a provider" });
    await owner.see({ text: "Could not load the provider catalog." }, { timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-provider-catalog-retry" });
    await owner.notSee({ testId: "gateway-provider-catalog-empty" });
    const failed = (await world.catalogFaults.requests()).filter((request) => request.kind === "catalog" && request.completed && request.status === 503);
    expect(failed.length).toBeGreaterThan(0);
    await owner.screenshot();
    await world.catalogFaults.recover("catalog");
    await owner.click({ testId: "gateway-provider-catalog-retry" });
    await owner.see({ testId: "gateway-provider-pick-anthropic" }, { timeoutMs: 30_000 });
  });

  await step("LiteLLM is in the catalog and opens its setup form", async () => {
    await owner.type({ placeholder: "Filter by name" }, "litellm");
    await owner.click({ testId: "gateway-provider-pick-litellm" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add LiteLLM", timeoutMs: 30_000 });
    await owner.see({ testId: "litellm-base-url" });
    await owner.see({ testId: "litellm-connect" });
    await owner.screenshot();
  });

  await step("picking a provider with a slow model read keeps the model rows in place", async () => {
    await owner.navigate(addProvider);
    await owner.see({ testId: "gateway-provider-pick-anthropic" }, { timeoutMs: 30_000 });
    await world.catalogFaults.hold("models");
    await owner.click({ testId: "gateway-provider-pick-anthropic" });
    await owner.see({ testId: "gateway-models-pick" }, { timeoutMs: 30_000 });
    await owner.click({ testId: "gateway-models-pick" });
    await owner.see({ testId: "gateway-models-loading" });
    const held = await page.eventually(async () => (await world.catalogFaults.requests()).filter((request) => request.kind === "models" && request.mode === "hold" && !request.completed), {
      within: 10_000, label: "the authenticated model catalog response is held", until: (requests) => requests.length > 0,
    });
    const placeholders = (await page.dom('[data-testid="gateway-models-loading"]')).elements;
    expect(placeholders).toHaveLength(4);
    await owner.notSee({ testId: "gateway-models-empty" });
    await owner.notSee({ testId: "gateway-models-error" });
    evidence.recordAssertionEvidence("a slow model read is visibly loading, not empty", `${held.length} authenticated HTTP 200 model response(s) held; ${placeholders.length} model-shaped placeholders; no empty or error claim.`, held.length > 0 && placeholders.length === 4);
    await owner.screenshot();
    await world.catalogFaults.recover("models");
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add Anthropic", timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-models-count" });
  });

  await step("a failed model catalog stops loading and offers Retry", async () => {
    await world.catalogFaults.fail("models");
    await owner.reload();
    await owner.see({ testId: "gateway-models-error" }, { text: /^Could not load this provider's models\. Existing configuration has not changed\.\s*Retry$/, timeoutMs: 30_000 });
    await owner.click({ testId: "gateway-models-pick" });
    await owner.see({ testId: "gateway-models-retry" });
    await owner.notSee({ testId: "gateway-models-loading" });
    await owner.notSee({ text: "Loading models…" });
    await owner.notSee({ testId: "gateway-models-empty" });
    const failed = (await world.catalogFaults.requests()).filter((request) => request.kind === "models" && request.completed && request.status === 503);
    evidence.recordAssertionEvidence("failed models never masquerade as endless loading", `${failed.length} model read(s) answered HTTP 503; Retry is available; no loading rows or empty-success claim.`, failed.length > 0);
    expect(failed.length).toBeGreaterThan(0);
    await owner.screenshot();
  });

  await step("after: a successful empty model catalog says no models are available and protects Save", async () => {
    await world.catalogFaults.empty("models");
    await owner.click({ testId: "gateway-models-retry" });
    await owner.see({ testId: "gateway-models-empty" }, { text: /^No models are available in this provider's catalog\.\s*Retry$/, timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-models-count" }, { text: "0 of 0 selected" });
    await owner.notSee({ testId: "gateway-models-loading" });
    await owner.notSee({ testId: "gateway-models-error" });
    const disabled = (await page.dom('[data-testid="gateway-models-select-all"]:disabled, [data-testid="gateway-models-clear"]:disabled')).elements;
    expect(disabled).toHaveLength(2);
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ text: "No models are available in this provider's catalog. Retry the catalog before saving." });
    const empty = (await world.catalogFaults.requests()).filter((request) => request.kind === "models" && request.mode === "empty" && request.completed && request.status === 200);
    evidence.recordAssertionEvidence("empty success is actionable and cannot erase model choices", `${empty.length} HTTP 200 empty model response(s); 0 of 0 models; both bulk actions disabled; Save asks to retry instead of accepting an empty catalog.`, empty.length > 0 && disabled.length === 2);
    expect(empty.length).toBeGreaterThan(0);
    await owner.screenshot();
  });

  await step("after: Retry restores models and a nonmatching filter has its own honest empty result", async () => {
    await world.catalogFaults.recover("models");
    await owner.click({ testId: "gateway-models-retry" });
    const available = await page.eventually(async () => (await page.dom('[data-testid^="gateway-model-"]')).elements, {
      within: 30_000, label: "the restored model rows are available", until: (models) => models.length > 0,
    });
    await owner.see({ testId: "gateway-models-count" }, { timeoutMs: 30_000 });
    await owner.notSee({ testId: "gateway-models-empty" });
    expect(available.length).toBeGreaterThan(0);
    await owner.type({ placeholder: "Filter models" }, "no-model-has-this-name");
    await owner.see({ testId: "gateway-models-filter-empty" }, { text: "No models match that filter. Try another name." });
    await owner.notSee({ testId: "gateway-models-loading" });
    const matching = (await page.dom('[data-testid^="gateway-model-"]')).elements;
    expect(matching).toHaveLength(0);
    evidence.recordAssertionEvidence("a filter miss is not a missing or loading catalog", `${available.length} restored models before filtering; ${matching.length} matches after an unmatched name; the result directs the owner to try another name.`, available.length > 0 && matching.length === 0);
    await owner.screenshot();
  });

  await step("the recovered provider can be saved normally without exposing its key", async () => {
    await owner.click({ testId: "gateway-models-all" });
    await owner.type({ testId: "gateway-provider-api-key" }, "sk-ant-eval-recovery-not-real");
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ role: "link", label: "Manage Anthropic" }, { timeoutMs: 60_000 });
    const saved = await probe.api(world.den.admin, "/v1/inference-providers?scope=manageable");
    const provider = providers(saved.body).find((entry) => entry.providerId === "anthropic");
    expect(provider).toBeDefined();
    expect(saved.text).not.toContain("sk-ant-eval-recovery");
    evidence.recordAssertionEvidence("catalog recovery preserves the ordinary provider flow", `Manage Anthropic is visible; Den returned ${providers(saved.body).length} provider and no key material.`, Boolean(provider) && !saved.text.includes("sk-ant-eval-recovery"));
    // Capture only after navigation, when the credential input is no longer on screen.
    await owner.screenshot();
  });

  await step("the owner adds Amazon Bedrock where each person signs in with IAM Identity Center, without AWS keys", async () => {
    await owner.navigate(addProvider);
    await owner.see({ testId: "gateway-provider-catalog-filter" }, { timeoutMs: 30_000 });
    await owner.type({ testId: "gateway-provider-catalog-filter" }, "Bedrock");
    await owner.click({ testId: "gateway-provider-pick-amazon-bedrock" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add Amazon Bedrock", timeoutMs: 30_000 });
    await owner.type({ testId: "gateway-setting-region" }, "us-west-2");
    await owner.click({ role: "radio", label: "Each member signs in" });
    for (const [field, value] of Object.entries(AWS_SSO)) await owner.type({ testId: `gateway-aws-sso-${field}` }, value);
    await owner.notSee({ testId: "gateway-aws-access-key-id" });
    await owner.screenshot();
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ role: "link", label: "Manage Amazon Bedrock" }, { timeoutMs: 60_000 });
    const bedrock = providers((await probe.api(world.den.admin, "/v1/inference-providers?scope=manageable")).body).find((entry) => entry.providerId === "amazon-bedrock");
    expect(gatewayFirstCredentialSet(bedrock)).toMatchObject({ credentialMode: "member", configured: true, awsSso: AWS_SSO });
  });

  await step("the owner adds Microsoft Foundry where each person signs in with Entra ID; the redirect URI is shown and the client secret never comes back", async () => {
    const secret = "eval~entra-client-secret-not-real";
    await owner.navigate(addProvider);
    await owner.see({ testId: "gateway-provider-catalog-filter" }, { timeoutMs: 30_000 });
    await owner.type({ testId: "gateway-provider-catalog-filter" }, "Foundry");
    await owner.click({ testId: "gateway-provider-pick-microsoft-foundry" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add Microsoft Foundry (Claude)", timeoutMs: 30_000 });
    await owner.type({ testId: "gateway-setting-resourceName" }, "acme-foundry");
    await owner.click({ role: "radio", label: "Each member signs in" });
    await owner.type({ testId: "gateway-oauth-tenant-id" }, "6f0e3a5e-1b2c-4d3e-8f90-0a1b2c3d4e5f");
    await owner.type({ testId: "gateway-oauth-client-id" }, "0b6c2d1e-7f8a-4b9c-a0d1-e2f3a4b5c6d7");
    await owner.type({ testId: "gateway-oauth-client-secret" }, secret);
    await owner.click({ testId: "gateway-provider-save" });
    await owner.click({ role: "link", label: "Manage Microsoft Foundry (Claude)" });
    await owner.see({ text: "Redirect URI" }, { timeoutMs: 60_000 });
    const after = await probe.api(world.den.admin, "/v1/inference-providers?scope=manageable");
    const foundry = providers(after.body).find((entry) => entry.providerId === "microsoft-foundry");
    const callback = String(foundry?.oauthCallbackUrl ?? "");
    expect(callback).toMatch(/\/v1\/inference-providers\/oauth\/callback$/);
    await owner.see({ text: callback });
    expect(gatewayFirstCredentialSet(foundry)).toMatchObject({ credentialMode: "member", hasOauthClientSecret: true });
    expect(after.text).not.toContain(secret);
    await owner.screenshot();
  });

  await step("a teammate who has not signed in to Amazon Bedrock is sent to AWS from OpenWork's connect page", async () => {
    const teammate = user.on(world.memberWeb);
    const bedrock = providers((await probe.api(world.teammate, "/v1/inference-providers")).body).find((entry) => entry.providerId === "amazon-bedrock");
    expect(bedrock?.credentialStatus).toBe("member_auth_required");
    const start = await probe.api(world.teammate, `/v1/inference-providers/${String(bedrock?.id)}/oauth/start`, {
      headers: { accept: "application/json", "x-openwork-org-id": world.orgId },
    });
    const authUrl = String(gatewayRecord(start.body).authUrl ?? "");
    expect(authUrl).toContain("/gateway/connect");
    await teammate.navigate(authUrl);
    await teammate.see({ role: "heading", label: "Sign in to AWS" }, { timeoutMs: 60_000 });
    await teammate.see({ testId: "gateway-connect-aws-start" }, { text: "Continue to AWS" });
    await teammate.screenshot();
  });

  await step("a teammate cannot use the recovered editor or bypass its administration boundary", async () => {
    const teammate = user.on(world.memberWeb);
    await teammate.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway/providers/new?provider=anthropic`);
    await teammate.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
    await teammate.notSee({ testId: "gateway-provider-api-key" }, { timeoutMs: 30_000 });
    await teammate.notSee({ testId: "gateway-provider-save" });
    const denied = await probe.api(world.teammate, "/v1/inference-providers?scope=manageable");
    expect(denied.response.status).toBe(403);
    evidence.recordAssertionEvidence("catalog recovery does not give a teammate editing rights", `The teammate sees no credential form or Save; manageable providers remains HTTP ${denied.response.status}.`, denied.response.status === 403);
    await teammate.screenshot();
  });
});
