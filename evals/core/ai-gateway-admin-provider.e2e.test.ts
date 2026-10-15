import { expect } from "vitest";
import { gatewayAccessAudiences as accessAudiences, gatewayProviders as providers } from "@openwork/behaviors";
import { spec } from "@openwork/testkit";
import { aiGatewayCatalogStates } from "../worlds/ai-gateway-catalog-states.ts";

const test = spec.world(aiGatewayCatalogStates, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

test("an owner shares Anthropic models, can cancel removing a person's or team's access, and a teammate cannot administer it", async ({
  world, user, probe, step, evidence,
}) => {
  const owner = user.on(world.web);
  const teammate = user.on(world.memberWeb);
  const page = probe.on(world.web);
  const manageable = "/v1/inference-providers?scope=manageable";
  const confirmationClosed = async () => {
    await page.eventually(() => page.dom('[data-testid="confirm-dialog"]'), {
      within: 10_000, label: "the access confirmation has closed", until: (found) => found.elements.length === 0,
    });
    await owner.notSee({ testId: "confirm-dialog" });
  };

  await step("before: the owner opens AI Gateway and it is empty", async () => {
    await owner.see({ testId: "gateway-providers-empty" }, { timeoutMs: 90_000 });
    await owner.see({ text: "No providers yet" });
    const before = await probe.api(world.den.admin, manageable);
    evidence.recordAssertionEvidence("no providers yet", `GET ${manageable} → ${before.response.status}, ${providers(before.body).length} providers`, providers(before.body).length === 0);
    await owner.screenshot();
  });

  await step("the owner picks Anthropic from the catalog", async () => {
    await owner.click({ testId: "gateway-provider-create" });
    await owner.see({ role: "heading", label: "Add a provider" }, { timeoutMs: 30_000 });
    await owner.see({ text: "Start here" });
    await owner.see({ placeholder: "Filter by name" });
    await owner.see({ testId: "gateway-provider-pick-litellm" });
    const catalogRows = (await page.dom('[data-testid="gateway-provider-catalog"] a')).elements;
    evidence.recordAssertionEvidence("the owner can browse the catalog, LiteLLM included", `${catalogRows.length} provider links, including LiteLLM.`, catalogRows.length > 0);
    expect(catalogRows.length).toBeGreaterThan(0);
    await owner.screenshot();
    await owner.click({ testId: "gateway-provider-pick-anthropic" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add Anthropic", timeoutMs: 30_000 });
    await owner.screenshot();
  });

  await step("after: one key, everyone, all models becomes a provider row shared with the whole org", async () => {
    await owner.type({ testId: "gateway-provider-api-key" }, "sk-ant-eval-not-a-real-key");
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ testId: "gateway-provider-open" }, { timeoutMs: 60_000 });
    await owner.see({ text: "Anthropic" });
    await owner.see({ testId: "gateway-provider-audience" }, { text: "Everyone" });
    await owner.see({ text: "Ready" });
    const after = await probe.api(world.den.admin, manageable);
    const saved = providers(after.body).find((entry) => entry.providerId === "anthropic");
    const grants = Array.isArray(saved?.accessGrants) ? saved.accessGrants : [];
    const orgWide = grants.some((grant) => JSON.stringify(grant).includes('"type":"organization"'));
    evidence.recordAssertionEvidence("provider saved with an org-wide grant and no secret in the response", `${grants.length} grant(s), organization audience: ${orgWide}; response contains the key: ${after.text.includes("sk-ant-eval")}`, orgWide && !after.text.includes("sk-ant-eval"));
    expect(orgWide).toBe(true);
    expect(after.text).not.toContain("sk-ant-eval");
    await owner.see({ role: "link", label: "Add a provider" });
    const rawIds = (await page.dom('[data-testid="gateway-provider-row"] .font-mono')).elements;
    expect(rawIds).toHaveLength(0);
    await owner.screenshot();
  });

  await step("the owner switches the org to only the models they provide", async () => {
    await owner.see({ testId: "gateway-model-policy-state" }, { text: "Any model" });
    await owner.click({ testId: "gateway-model-policy-open" });
    await owner.click({ testId: "gateway-model-access-managed" });
    await owner.click({ testId: "gateway-model-policy-save" });
    await owner.see({ testId: "gateway-model-policy-state" }, { text: "Only models you provide", timeoutMs: 30_000 });
    const policies = await probe.api(world.den.admin, "/v1/desktop-policies");
    const text = JSON.stringify(policies.body);
    evidence.recordAssertionEvidence("default desktop policy blocks personal providers", `GET /v1/desktop-policies → ${policies.response.status}; allowCustomProviders:false present: ${text.includes('"allowCustomProviders":false')}`, text.includes('"allowCustomProviders":false'));
    await owner.screenshot();
  });

  await step("the owner adds a person and a team using the same sized access controls", async () => {
    await owner.click({ role: "link", label: "Manage Anthropic" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Anthropic", timeoutMs: 60_000 });
    await owner.see({ testId: "gateway-models-all" });
    const buttons = (await page.dom('[data-testid="gateway-access-add-person"], [data-testid="gateway-access-add-team"]')).elements;
    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => button.rect.height)).toEqual([32, 32]);
    await owner.click({ testId: "gateway-access-add-person" });
    await owner.click({ role: "combobox", label: "Person" });
    await owner.click({ role: "option", label: /^Gateway Teammate/ });
    await owner.click({ testId: "gateway-access-add-team" });
    await owner.click({ role: "combobox", label: "Team" });
    await owner.click({ role: "option", label: new RegExp(`^${world.teamName}`) });
    await owner.see({ role: "button", label: "Remove access for Gateway Teammate" });
    await owner.see({ role: "button", label: `Remove access for ${world.teamName}` });
    await owner.notSee({ role: "button", label: "Revoke" });
    expect((await page.dom('[data-testid="gateway-access-row"]')).elements).toHaveLength(2);
    evidence.recordAssertionEvidence("person and team access use shared 32px controls", `Add person and Add team are ${buttons.map((button) => button.rect.height).join(" / ")}px; both audience rows offer Remove rather than Revoke.`, buttons.every((button) => button.rect.height === 32));
    await owner.screenshot();
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ role: "link", label: "Manage Anthropic" }, { timeoutMs: 60_000 });
    const saved = providers((await probe.api(world.den.admin, manageable)).body).find((entry) => entry.providerId === "anthropic");
    const audiences = accessAudiences(saved);
    expect(audiences.some((audience) => audience.type === "member" && audience.memberId === world.teammateId)).toBe(true);
    expect(audiences.some((audience) => audience.type === "team" && audience.teamId === world.teamId)).toBe(true);
    expect(audiences.some((audience) => audience.type === "organization")).toBe(false);
  });

  await step("removing a person's access names the risk and Cancel keeps the person and team", async () => {
    await owner.click({ role: "link", label: "Manage Anthropic" });
    await owner.see({ role: "button", label: "Remove access for Gateway Teammate" }, { timeoutMs: 60_000 });
    await owner.click({ role: "button", label: "Remove access for Gateway Teammate" });
    await owner.see({ testId: "confirm-dialog" }, { text: /^Remove access for Gateway Teammate\?\s/ });
    await owner.see({ text: "Gateway Teammate will lose this direct access to Anthropic when you save. Access granted another way stays unchanged. You can add them back." });
    await owner.see({ role: "button", label: "Remove access" });
    await owner.see({ testId: "confirm-dialog-cancel" });
    const dialog = (await page.dom('[data-testid="confirm-dialog"]')).elements;
    expect(dialog).toHaveLength(1);
    await owner.screenshot();
    await owner.click({ testId: "confirm-dialog-cancel" });
    await confirmationClosed();
    await owner.see({ role: "button", label: "Remove access for Gateway Teammate" });
    await owner.see({ role: "button", label: `Remove access for ${world.teamName}` });
    const saved = providers((await probe.api(world.den.admin, manageable)).body).find((entry) => entry.providerId === "anthropic");
    const audiences = accessAudiences(saved);
    expect(audiences).toHaveLength(2);
    evidence.recordAssertionEvidence("Cancel leaves both saved audiences intact", `${dialog.length} confirmation dialog; after Cancel, the person and team remain on screen and Den still has ${audiences.length} access grants.`, audiences.length === 2);
    await owner.screenshot();
  });

  await step("after: confirming a person's removal affects only that direct grant when saved", async () => {
    await owner.click({ role: "button", label: "Remove access for Gateway Teammate" });
    await owner.see({ testId: "confirm-dialog" });
    await owner.click({ role: "button", label: "Remove access" });
    await confirmationClosed();
    await owner.notSee({ role: "button", label: "Remove access for Gateway Teammate" });
    await owner.see({ role: "button", label: `Remove access for ${world.teamName}` });
    const beforeSave = accessAudiences(providers((await probe.api(world.den.admin, manageable)).body).find((entry) => entry.providerId === "anthropic"));
    expect(beforeSave).toHaveLength(2);
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ role: "link", label: "Manage Anthropic" }, { timeoutMs: 60_000 });
    const afterSave = accessAudiences(providers((await probe.api(world.den.admin, manageable)).body).find((entry) => entry.providerId === "anthropic"));
    expect(afterSave).toEqual([expect.objectContaining({ type: "team", teamId: world.teamId })]);
    const teammateProviders = providers((await probe.api(world.teammate, "/v1/inference-providers")).body);
    expect(teammateProviders.some((entry) => entry.providerId === "anthropic")).toBe(true);
    evidence.recordAssertionEvidence("removing one grant preserves independent team access", `Before Save: ${beforeSave.length} grants; after Save: ${afterSave.length} team grant; the teammate can still use Anthropic through that team.`, beforeSave.length === 2 && afterSave.length === 1 && teammateProviders.some((entry) => entry.providerId === "anthropic"));
    await owner.screenshot();
  });

  await step("removing the team also asks first and Cancel keeps its saved access", async () => {
    await owner.click({ role: "link", label: "Manage Anthropic" });
    await owner.see({ role: "button", label: `Remove access for ${world.teamName}` }, { timeoutMs: 60_000 });
    await owner.click({ role: "button", label: `Remove access for ${world.teamName}` });
    await owner.see({ testId: "confirm-dialog" }, { text: new RegExp(`^Remove access for ${world.teamName}\\?\\s`) });
    await owner.see({ text: `Members of ${world.teamName} will lose this direct access to Anthropic when you save. Access granted another way stays unchanged. You can add them back.` });
    await owner.screenshot();
    await owner.click({ testId: "confirm-dialog-cancel" });
    await confirmationClosed();
    await owner.see({ role: "button", label: `Remove access for ${world.teamName}` });
    const audiences = accessAudiences(providers((await probe.api(world.den.admin, manageable)).body).find((entry) => entry.providerId === "anthropic"));
    expect(audiences).toEqual([expect.objectContaining({ type: "team", teamId: world.teamId })]);
    evidence.recordAssertionEvidence("Cancel also preserves the team's access", `${audiences.length} saved team grant remains after cancelling the named team confirmation.`, audiences.length === 1 && audiences[0]?.teamId === world.teamId);
    await owner.screenshot();
  });

  await step("the owner adds Amazon Bedrock with AWS keys, then Bedrock (OpenAI) reuses them without pasting them again", async () => {
    const awsKeyId = "AKIAEVALNOTAREALKEY1";
    const awsSecret = "eval-bedrock-secret-not-a-real-key";
    await owner.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway/providers/new`);
    await owner.see({ testId: "gateway-provider-catalog-filter" }, { timeoutMs: 30_000 });
    await owner.type({ testId: "gateway-provider-catalog-filter" }, "Bedrock");
    await owner.click({ testId: "gateway-provider-pick-amazon-bedrock" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add Amazon Bedrock", timeoutMs: 30_000 });
    await owner.type({ testId: "gateway-setting-region" }, "us-east-1");
    await owner.type({ testId: "gateway-aws-access-key-id" }, awsKeyId);
    await owner.type({ testId: "gateway-aws-secret-access-key" }, awsSecret);
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ role: "link", label: "Manage Amazon Bedrock" }, { timeoutMs: 60_000 });
    await owner.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway/providers/new`);
    await owner.see({ testId: "gateway-provider-catalog-filter" }, { timeoutMs: 30_000 });
    await owner.type({ testId: "gateway-provider-catalog-filter" }, "Bedrock");
    await owner.click({ testId: "gateway-provider-pick-amazon-bedrock-mantle" });
    await owner.see({ text: "Use AWS keys you already saved" }, { timeoutMs: 30_000 });
    await owner.click({ testId: "gateway-aws-reuse-keys" });
    await owner.see({ text: "Using the AWS keys saved for Amazon Bedrock" });
    await owner.notSee({ testId: "gateway-aws-secret-access-key" });
    await owner.type({ testId: "gateway-setting-region" }, "us-west-2");
    await owner.screenshot();
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ role: "link", label: "Manage Amazon Bedrock (OpenAI)" }, { timeoutMs: 60_000 });
    const after = await probe.api(world.den.admin, manageable);
    const ready = providers(after.body).filter((entry) => String(entry.providerId).startsWith("amazon-bedrock") && entry.credentialStatus === "ready");
    expect(ready).toHaveLength(2);
    expect(after.text).not.toContain(awsSecret);
    expect(after.text).not.toContain(awsKeyId);
  });

  await step("a teammate has no AI Gateway page and cannot list providers as an admin", async () => {
    await teammate.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
    await teammate.notSee({ role: "link", label: /AI Gateway/ });
    await teammate.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway?tab=ai-providers`);
    await teammate.notSee({ testId: "gateway-provider-create" }, { timeoutMs: 30_000 });
    const denied = await probe.api(world.teammate, manageable);
    evidence.recordAssertionEvidence("teammate is refused the admin list", `GET ${manageable} as teammate → ${denied.response.status}`, denied.response.status === 403);
    expect(denied.response.status).toBe(403);
    await teammate.screenshot();
  });
});
