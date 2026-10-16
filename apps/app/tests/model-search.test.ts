import { describe, expect, test } from "bun:test";
import { FAST_DEFAULT_VARIANT, fastVariantId } from "@openwork/types/cloud-model-fast";

import type { ModelOption } from "../src/app/types";
import { resolveSearchIntent, searchIntentLabel, searchModels } from "../src/react-app/domains/models/model-search";

const effort = (...values: string[]) => [null, ...values].map((value) => ({ value, label: value ?? "Default", description: "" }));
const withFast = (...values: string[]) => [...effort(...values), ...[null, ...values].map((value) => ({ value: fastVariantId(value), label: `${value ?? "Default"} fast`, description: "" }))];
const model = (providerID: string, modelID: string, title: string, description: string, behaviorOptions = effort()): ModelOption => ({
  providerID, modelID, title, description, behaviorTitle: "Effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null, behaviorOptions, isFree: false,
});

const anthropicOpus = model("anthropic", "claude-opus-5-5", "Claude Opus 5.5", "Anthropic", withFast("high", "max"));
const anthropicSonnet = model("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5", "Anthropic", effort("high"));
const routerOpus = model("openrouter", "anthropic/claude-opus-5.5", "Anthropic: Claude Opus 5.5", "OpenRouter");
const routerGpt = model("openrouter", "openai/gpt-5.5", "OpenAI: GPT-5.5", "OpenRouter");
const openworkOpus = model("openwork", "claude-opus-5-5", "Claude Opus 5.5", "OpenWork Models", withFast("high"));
const grok = model("xai", "grok-4", "Grok 4", "xAI");
const groq = model("groq", "llama-3.3-70b", "Llama 3.3 70B", "Groq");
const gpt = model("openai", "gpt-5.1", "GPT-5.1", "OpenAI");
const all = [anthropicOpus, anthropicSonnet, routerOpus, routerGpt, openworkOpus, grok, groq, gpt];
const top = (options: readonly ModelOption[], query: string) => searchModels(options, query).matches.map((match) => `${match.option.providerID}/${match.option.modelID}`);

describe("model search", () => {
  test("a named provider comes first", () => {
    const result = searchModels(all, "opus 5.5 openrouter");
    expect(top(all, "opus 5.5 openrouter")[0]).toBe("openrouter/anthropic/claude-opus-5.5");
    expect(result.provider).toEqual({ label: "OpenRouter", found: true });
  });

  test("when the provider has no match, or is not connected, the same model from others shows", () => {
    const withoutRouter = all.filter((option) => option.providerID !== "openrouter");
    const result = searchModels(withoutRouter, "opus 5.5 openrouter");
    expect(result.provider).toEqual({ label: "OpenRouter", found: false });
    expect(result.modelWords).toEqual(["opus", "5.5"]);
    expect(top(withoutRouter, "opus 5.5 openrouter").slice(0, 2).sort()).toEqual(["anthropic/claude-opus-5-5", "openwork/claude-opus-5-5"]);
  });

  test("versions are exact: 5.5 never finds 4.5", () => {
    expect(top(all, "5.5")).not.toContain("anthropic/claude-sonnet-4-5");
    expect(top(all, "claude 4.5")[0]).toBe("anthropic/claude-sonnet-4-5");
  });

  test("typos are forgiven in names and providers", () => {
    expect(top(all, "sonet")[0]).toBe("anthropic/claude-sonnet-4-5");
    expect(top(all, "cluade opus")[0]).toMatch(/opus/);
    const result = searchModels(all, "anthrpic");
    expect(result.provider?.label).toBe("Anthropic");
    expect(result.modelWords).toEqual([]);
  });

  test("a provider alone lists its models, including its family served elsewhere", () => {
    const listed = top(all, "anthropic");
    expect(listed).toContain("anthropic/claude-opus-5-5");
    expect(listed).toContain("openrouter/anthropic/claude-opus-5.5");
    expect(listed).not.toContain("openai/gpt-5.1");
  });

  test("ow anthropic fast: OpenWork's Claude first, with Fast mode", () => {
    const result = searchModels(all, "ow anthropic fast");
    expect(result.intent).toEqual({ fast: true });
    expect(result.matches[0]?.option).toBe(openworkOpus);
    expect(resolveSearchIntent(openworkOpus, result.intent)).toEqual({ variant: FAST_DEFAULT_VARIANT, applied: ["Fast mode"], missing: [] });
  });

  test("a near-miss provider name that names a model stays a model word", () => {
    expect(top(all, "grok")[0]).toBe("xai/grok-4");
    expect(searchModels(all, "groq").provider?.label).toBe("Groq");
  });

  test("options never filter; a model without them is still picked, saying what it lacks", () => {
    const result = searchModels(all, "anthropic fast high");
    expect(result.intent).toEqual({ fast: true, effort: "high" });
    expect(resolveSearchIntent(anthropicOpus, result.intent).variant).toBe(fastVariantId("high"));
    expect(resolveSearchIntent(anthropicSonnet, result.intent)).toEqual({ variant: "high", applied: ["High effort"], missing: ["Fast mode"] });
    expect(searchIntentLabel(anthropicSonnet, result.intent)).toBe("With High effort. Fast mode isn't available");
    expect(searchIntentLabel(routerOpus, result.intent)).toBe("High effort and Fast mode aren't available");
    expect(resolveSearchIntent(routerOpus, result.intent)).toEqual({ applied: [], missing: ["High effort", "Fast mode"] });
  });

  test("plain searches keep working", () => {
    expect(top(all, "gpt")).toEqual(expect.arrayContaining(["openai/gpt-5.1", "openrouter/openai/gpt-5.5"]));
    expect(top(all, "llama")[0]).toBe("groq/llama-3.3-70b");
    expect(searchModels(all, "zzz").matches).toEqual([]);
  });
});
