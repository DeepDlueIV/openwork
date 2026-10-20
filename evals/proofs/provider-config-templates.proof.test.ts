import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { providerConfigTemplates } from "../worlds/provider-config-templates.ts";

const test = spec.world(providerConfigTemplates, {
  resources: { surfaces: [], services: [] }, needs: { commands: ["bun"] }, timeout: 240_000,
});

test("a member's environment and file configured providers answer on V2 without losing legacy endpoints", async ({ world, step, evidence }) => {
  await step("a missing endpoint variable identifies the affected provider without exposing credentials", async () => {
    const status = await world.status();
    expect(status.skippedProviderIds).toContain("fixture-missing");
    expect(status.lastError).toContain("MISSING_PROVIDER_ENDPOINT");
    expect(status.lastError).toContain("Settings > Environment");
    expect(JSON.stringify(status)).not.toContain(world.key);
    evidence.recordAssertionEvidence("Missing variables are actionable and secret-safe", String(status.lastError), true);
  });
  await step("environment and relative-file endpoints appear in the real model catalog", async () => {
    const catalog = await world.catalog();
    const rows = Array.isArray(catalog.data) ? catalog.data : [];
    for (const providerId of world.ids) {
      expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ providerID: providerId, id: world.model })]));
    }
    expect(JSON.stringify(catalog)).not.toContain("fixture-missing");
    evidence.recordAssertionEvidence("Each working provider has its own native model", world.ids.join(", ") + "; missing-variable provider absent", true);
  });
  for (const id of ["fixture-env", "fixture-file"]) {
    await step(`${id === "fixture-env" ? "Environment" : "File"} configuration produces a reply through the intended authenticated endpoint`, async () => {
      const result = await world.chat(id);
      expect(result.answered).toBe(true);
      expect(result.requests).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/v1/chat/completions", bearer: true, azure: false, model: world.model })]));
      evidence.recordAssertionEvidence("The selected configured provider answers, not a fallback", JSON.stringify(result.requests), result.answered);
    });
  }
  for (const id of world.ids.filter(id => id.startsWith("lpr_"))) {
    await step(`the legacy ${id.replace("lpr_fixture_", "").replaceAll("_", " ")} endpoint still answers`, async () => {
      const result = await world.chat(id);
      const azure = id.includes("azure");
      expect(result.answered).toBe(true);
      expect(result.requests).toEqual(expect.arrayContaining([expect.objectContaining({ path: azure ? "/openai/v1/responses" : "/v1/chat/completions", bearer: !azure, azure, model: world.model })]));
      evidence.recordAssertionEvidence("The legacy mapping retains its path and authentication", JSON.stringify(result.requests), result.answered);
    });
  }
});
