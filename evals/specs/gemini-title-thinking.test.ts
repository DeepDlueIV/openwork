import { eventually, spec, test } from "@openwork/testkit";
import { expect } from "vitest";
import { catalogCases, geminiTitleThinking, messages, modelID, record } from "../worlds/gemini-title-thinking.ts";

// Pure materializer controls accompany the actual engine boundary below.
test("Google catalog excludes unsupported heuristic efforts without overriding explicit choices", async ({ evidence }) => {
  const cases = catalogCases();
  for (const sdk of cases.sdks) {
    expect(sdk.result).toMatchObject({ minimal: { disabled: true }, low: { thinkingConfig: { thinkingLevel: "low" } } });
    expect(sdk.overrides).toMatchObject({ low: { disabled: true }, minimal: { custom: true } });
    expect(sdk.absent).toBeUndefined();
    expect(sdk.disabled).toBeUndefined();
    expect(sdk.mismatch).toBeUndefined();
  }
  expect(cases.bedrock).toBeUndefined();
  expect(cases.materialized).toMatchObject({ family: "gemini-flash",
    variants: { minimal: { disabled: true }, low: { thinkingConfig: { thinkingLevel: "low" } } } });
  expect(cases.materialized).not.toHaveProperty("reasoning_options");
  expect(cases.oldImport).toBe(true);
  expect(cases.currentImport).toBe(false);
  evidence.recordAssertionEvidence("Catalog materialization and existing imports", "Google and Vertex emit LOW and disable excluded MINIMAL; explicit overrides are preserved; missing effort metadata, disabled reasoning, mismatched model SDK and Bedrock remain untouched. Desktop import retains family, drops reasoning_options and re-imports an old model config version, but not the current version.", true);
});

const engineTest = spec.world(geminiTitleThinking, { needs: { placement: "local" }, timeout: 180_000 });
engineTest("a member gets a Google conversation name without changing ordinary chat effort", async ({ world, step, evidence }) => {
  await step("another local process cannot use the member's inference relay", async () => {
    expect(await world.untrustedRequest()).toBe(401);
    expect(world.requests).toEqual([]);
    evidence.recordAssertionEvidence("untrusted relay request denied", "The source-known fixture-only credential gets HTTP 401 before any inference request is recorded; a per-run random credential is required.", true);
  });
  if (!world.baseline) await step("the member can choose only catalog-supported efforts, including for a Gateway alias", async () => {
    const inventory = await world.engine("/provider");
    if (!record(inventory) || !Array.isArray(inventory.all)) throw new Error("Missing provider inventory");
    for (const [providerId, id] of [["lpr_google_witness", modelID], ["ipr_synthetic", "gwm_synthetic"]]) {
      const provider = inventory.all.find(value => record(value) && value.id === providerId);
      if (!record(provider) || !record(provider.models)) throw new Error("Missing Google provider");
      const model = provider.models[id];
      if (!record(model) || !record(model.variants)) throw new Error("Missing variants");
      expect(Object.keys(model.variants).sort()).toEqual(["high", "low", "medium"]);
    }
    evidence.recordAssertionEvidence("supported effort choices", "Both the named Google model and opaque Gateway alias expose exactly LOW, MEDIUM, HIGH; MINIMAL is absent.", true);
  });
  for (const message of world.live ? [messages[0]] : messages) {
    world.setWording(message);
    const offset = world.requests.length;
    const created = await world.engine("/session", {});
    if (!record(created) || typeof created.id !== "string") throw new Error("Missing session id");
    const id = created.id;
    await step("the member starts a conversation using their Google provider", async () => {
      const reply = await world.engine(`/session/${id}/message`, { model: { providerID: "lpr_google_witness", modelID }, variant: "high",
        parts: [{ type: "text", text: "Tell me one short fact about kites." }] });
      expect(reply).toMatchObject({ info: { finish: "stop" } });
      expect(record(reply) && record(reply.info) && reply.info.error).toBeUndefined();
      evidence.recordAssertionEvidence("ordinary chat completes", `Engine ${world.version}: HIGH chat completed without an error`, true);
    });
    await step("the automatic title uses only a supported thinking level", async () => {
      await eventually(() => world.requests.slice(offset).some(item => item.title), { within: 30_000, until: value => value });
      const slice = world.requests.slice(offset);
      expect(slice.filter(item => item.title)).toEqual([expect.objectContaining({ level: world.baseline ? "minimal" : "low", status: world.baseline ? 400 : 200, model: modelID })]);
      expect(slice.filter(item => !item.title)).toEqual([expect.objectContaining({ level: "high", status: 200, model: modelID })]);
      evidence.recordAssertionEvidence(`Google ${world.live ? "LIVE" : "mock"} wire requests`, JSON.stringify(slice), true);
    });
    await step("the conversation keeps its generated name", async () => {
      if (!world.baseline) await eventually(() => world.engine(`/session/${id}`), { within: 30_000,
        until: value => record(value) && typeof value.title === "string" && !value.title.startsWith("New session - ") });
      const session = await world.engine(`/session/${id}`);
      expect(session).toMatchObject({ title: world.baseline ? expect.stringMatching(/^New session - /) : expect.any(String) });
      evidence.recordAssertionEvidence("persisted conversation name", JSON.stringify({ title: record(session) ? session.title : undefined, baseline: world.baseline }), true);
    });
  }
  expect(world.errors).toEqual([]);
});
