import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { aiGatewayCatalogStates } from "../worlds/ai-gateway-catalog-states.ts";

/** Every organization sees LiteLLM in the provider catalog; the owner must also survive catalog read faults. */
const test = spec.world(aiGatewayCatalogStates, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

const picks = '[data-testid="gateway-provider-catalog"] [data-testid^="gateway-provider-pick-"]:not([data-testid="gateway-provider-pick-compatible"])';

test("an owner can recover a provider catalog, find LiteLLM in it and open its setup form", async ({
  world, user, probe, step, evidence,
}) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const providers = `${world.den.ref.webUrl}/dashboard/ai-gateway?tab=ai-providers`;

  await step("LiteLLM belongs to the first ten providers above Show more", async () => {
    await owner.see({ testId: "gateway-providers-empty" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Add a provider" });
    await owner.see({ role: "heading", label: "Add a provider" }, { timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-provider-pick-litellm" }, { timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-provider-catalog-more" });
    const visible = (await page.dom(picks)).elements;
    const liteLlm = (await page.dom('[data-testid="gateway-provider-pick-litellm"]')).elements[0];
    const more = (await page.dom('[data-testid="gateway-provider-catalog-more"]')).elements[0];
    expect(visible).toHaveLength(10);
    expect(liteLlm).toBeDefined();
    expect(more).toBeDefined();
    expect(liteLlm?.rect.bottom).toBeLessThanOrEqual(more?.rect.top ?? 0);
    const hidden = Number(more?.text.match(/^Show (\d+) more/)?.[1]);
    expect(hidden).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("LiteLLM is counted in the collapsed catalog", `${visible.length} initial providers, including LiteLLM; its row ends at ${liteLlm?.rect.bottom}px above Show more at ${more?.rect.top}px; ${hidden} providers remain.`, visible.length === 10 && Boolean(liteLlm && more && liteLlm.rect.bottom <= more.rect.top));
    await owner.screenshot();
    await owner.click({ testId: "gateway-provider-catalog-more" });
    const expanded = await page.eventually(async () => (await page.dom(picks)).elements, {
      within: 10_000, label: "Show more reveals every remaining provider", until: (rows) => rows.length === visible.length + hidden,
    });
    expect(expanded).toHaveLength(visible.length + hidden);
    expect((await page.dom('[data-testid="gateway-provider-pick-litellm"]')).elements).toHaveLength(1);
    await owner.notSee({ testId: "gateway-provider-catalog-more" });
  });

  await step("filtering LiteLLM returns one provider and never an empty message", async () => {
    await owner.type({ placeholder: "Filter by name" }, "litellm");
    await owner.see({ testId: "gateway-provider-pick-litellm" });
    await owner.notSee({ testId: "gateway-provider-catalog-empty" });
    await owner.notSee({ text: "No providers match that filter. Try another name." });
    await owner.notSee({ testId: "gateway-provider-catalog-more" });
    const matching = (await page.dom(picks)).elements;
    expect(matching).toHaveLength(1);
    evidence.recordAssertionEvidence("LiteLLM participates in the same filter as every provider", `${matching.length} matching provider, LiteLLM; no empty message, compatibility shortcut, or Show more control.`, matching.length === 1);
    await owner.screenshot();
    await owner.type({ placeholder: "Filter by name" }, "no-provider-has-this-name", { replace: true });
    await owner.see({ testId: "gateway-provider-catalog-empty" });
    await owner.notSee({ testId: "gateway-provider-pick-litellm" });
  });

  await step("a slow catalog keeps provider-shaped placeholders instead of saying it is empty", async () => {
    await world.catalogFaults.hold("catalog");
    await owner.reload();
    await owner.see({ testId: "gateway-provider-catalog-loading" }, { timeoutMs: 30_000 });
    const held = await page.eventually(async () => (await world.catalogFaults.requests()).filter((request) => request.kind === "catalog" && request.mode === "hold" && !request.completed), {
      within: 10_000, label: "the authenticated catalog response is held", until: (requests) => requests.length > 0,
    });
    const rows = (await page.dom('[data-testid="gateway-provider-catalog-loading"]')).elements;
    expect(rows).toHaveLength(10);
    await owner.notSee({ testId: "gateway-provider-catalog-empty" });
    evidence.recordAssertionEvidence("a real slow read shows ten placeholders, not an empty catalog", `${held.length} HTTP 200 catalog response(s) held; ${rows.length} provider-shaped rows visible.`, held.length > 0 && rows.length === 10);
    await owner.screenshot();
    await world.catalogFaults.recover("catalog");
    await owner.see({ testId: "gateway-provider-pick-anthropic" }, { timeoutMs: 30_000 });
  });

  await step("a failed catalog offers Retry and does not claim that no providers exist", async () => {
    await world.catalogFaults.fail("catalog");
    await owner.reload();
    await owner.see({ text: "Could not load the provider catalog." }, { timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-provider-catalog-retry" });
    await owner.notSee({ testId: "gateway-provider-catalog-loading" });
    await owner.notSee({ testId: "gateway-provider-catalog-empty" });
    const failed = (await world.catalogFaults.requests()).filter((request) => request.kind === "catalog" && request.completed && request.status === 503);
    evidence.recordAssertionEvidence("the catalog failure is retryable", `${failed.length} authenticated catalog read(s) answered HTTP 503; Retry is visible and neither placeholders nor an empty-state claim remain.`, failed.length > 0);
    expect(failed.length).toBeGreaterThan(0);
    await owner.screenshot();
  });

  await step("after: Retry can show an honestly empty catalog, then restore the providers", async () => {
    await world.catalogFaults.empty("catalog");
    await owner.click({ testId: "gateway-provider-catalog-retry" });
    await owner.see({ testId: "gateway-provider-catalog-empty" }, { text: /^No providers are available\. Retry the catalog\.\s*Retry$/, timeoutMs: 30_000 });
    await owner.notSee({ testId: "gateway-provider-catalog-loading" });
    await owner.notSee({ testId: "gateway-provider-pick-litellm" });
    expect((await page.dom(picks)).elements).toHaveLength(0);
    const empty = (await world.catalogFaults.requests()).filter((request) => request.kind === "catalog" && request.mode === "empty" && request.completed && request.status === 200);
    evidence.recordAssertionEvidence("a successful empty read is not loading or failure", `${empty.length} HTTP 200 empty catalog response(s); 0 provider links; Retry stays available.`, empty.length > 0);
    expect(empty.length).toBeGreaterThan(0);
    await owner.screenshot();
    await world.catalogFaults.recover("catalog");
    await owner.click({ role: "button", label: "Retry" });
    await owner.see({ testId: "gateway-provider-pick-anthropic" }, { timeoutMs: 30_000 });
    await owner.notSee({ testId: "gateway-provider-catalog-empty" });
  });

  await step("the LiteLLM result opens its setup form", async () => {
    await owner.type({ placeholder: "Filter by name" }, "litellm", { replace: true });
    await owner.click({ testId: "gateway-provider-pick-litellm" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add LiteLLM", timeoutMs: 30_000 });
    await owner.see({ testId: "litellm-base-url" });
    await owner.see({ testId: "litellm-connect" });
    await owner.notSee({ testId: "litellm-preview-off" });
    evidence.recordAssertionEvidence("LiteLLM can be set up without a preview lock", "The setup form shows its base URL field and Connect button, and no preview notice.", true);
    await owner.screenshot();
  });

  await step("a teammate still cannot administer providers", async () => {
    const teammate = user.on(world.memberWeb);
    await teammate.navigate(providers);
    await teammate.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
    await teammate.notSee({ testId: "gateway-provider-create" }, { timeoutMs: 30_000 });
    const denied = await probe.api(world.teammate, "/v1/inference-providers?scope=manageable");
    expect(denied.response.status).toBe(403);
    evidence.recordAssertionEvidence("LiteLLM does not grant administration to a teammate", `The teammate sees no Add a provider action; manageable providers returns HTTP ${denied.response.status}.`, denied.response.status === 403);
    await teammate.screenshot();
  });
});
