import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProviderConfigTemplates } from "../src/provider-config-templates.js";
import { mapRuntimeProvidersToV2Specs } from "../src/engine-v2-preview.js";

const directory = "/fixture/runtime";
const definition = (baseURL = "{env:PROVIDER_URL}") => ({
  npm: "@ai-sdk/openai-compatible", env: ["PROVIDER_API_KEY"],
  options: { baseURL, apiKey: "{env:PROVIDER_API_KEY}", headers: { "x-region": "prefix-{env:REGION}" } },
  models: { model: { name: "Model" } },
});
const environment = new Map([["PROVIDER_URL", "http://127.0.0.1:8089/v1"], ["PROVIDER_API_KEY", "synthetic-provider-key"], ["REGION", "west"]]);
const options = { directory, environment, inheritedEnvironment: {} };

test("resolves provider strings before native mapping without forwarding unrelated environment values", async () => {
  const source = { local: definition() };
  const result = await resolveProviderConfigTemplates(source, { ...options, inheritedEnvironment: { UNRELATED_SECRET: "must-stay-private" } });
  assert.deepEqual(result.errors, []);
  const mapped = mapRuntimeProvidersToV2Specs(result.providers, environment, new Map(), new Set(["local"]));
  assert.deepEqual(mapped.skippedProviderIds, []);
  assert.equal(mapped.specs[0]?.baseUrl, "http://127.0.0.1:8089/v1");
  assert.equal(mapped.specs[0]?.apiKey, "synthetic-provider-key");
  assert.deepEqual(mapped.specs[0]?.headers, { "x-region": "prefix-west" });
  assert.ok(!JSON.stringify(result).includes("must-stay-private"));
  assert.equal(source.local.options.baseURL, "{env:PROVIDER_URL}");
});

test("inherits applied desktop environment precedence over the stored Settings value", async () => {
  const result = await resolveProviderConfigTemplates({ local: definition() }, {
    ...options, inheritedEnvironment: { PROVIDER_URL: "https://inherited.example.test/v1", PROVIDER_API_KEY: "inherited-key" },
  });
  const mapped = mapRuntimeProvidersToV2Specs(result.providers);
  assert.equal(mapped.specs[0]?.baseUrl, "https://inherited.example.test/v1");
  assert.equal(mapped.specs[0]?.apiKey, "inherited-key");
});

test("missing and empty variables give a provider-specific error without disabling other providers", async () => {
  const result = await resolveProviderConfigTemplates({ missing: definition(), good: { models: {} } }, {
    ...options, inheritedEnvironment: { PROVIDER_URL: "" },
  });
  assert.deepEqual(Object.keys(result.providers), ["good"]);
  assert.deepEqual(result.errors.map(e => [e.providerId, e.field, e.code]), [["missing", "options.baseURL", "missing_environment_variable"]]);
  assert.match(result.errors[0]?.message ?? "", /PROVIDER_URL.*Settings > Environment/);
  assert.ok(!JSON.stringify(result.errors).includes("synthetic-provider-key"));
});

test("resolves api, nested options, model fields and array strings with V1 syntax", async () => {
  const result = await resolveProviderConfigTemplates({ local: {
    ...definition(), api: "{env:PROVIDER_URL}", models: { "{env:REGION}": { headers: { authorization: "Bearer {env:PROVIDER_API_KEY}" }, options: { regions: ["{env:REGION}"] } } },
  } }, options);
  assert.deepEqual(result.errors, []);
  const provider = result.providers.local;
  assert.ok(provider && typeof provider === "object" && "api" in provider);
  assert.equal(provider.api, "http://127.0.0.1:8089/v1");
  assert.ok(JSON.stringify(provider).includes('"regions":["west"]'));
  assert.ok(JSON.stringify(provider).includes('"west":{"headers"'));
});

test("supports relative, absolute and home file references, trimming contents without recursive expansion", async () => {
  const paths: string[] = [];
  const result = await resolveProviderConfigTemplates({ local: { options: {
    baseURL: "{file:./endpoint}", apiKey: "{file:~/key}", extra: "prefix-{file:/absolute/value}",
  } } }, { ...options, home: "/fixture/home", readText: async path => { paths.push(path); return path.endsWith("endpoint") ? " https://proxy.example.test/v1\n" : '  quoted-"key\\value\n{env:NOT_EXPANDED}  '; } });
  assert.deepEqual(paths.sort(), ["/absolute/value", "/fixture/home/key", "/fixture/runtime/endpoint"]);
  assert.deepEqual(result.errors, []);
  assert.ok(JSON.stringify(result.providers).includes("https://proxy.example.test/v1"));
  assert.ok(JSON.stringify(result.providers).includes("{env:NOT_EXPANDED}"));
});

test("env expands before file references and unreadable files never expose substituted paths or OS errors", async () => {
  const result = await resolveProviderConfigTemplates({ local: { options: { apiKey: "{file:{env:PRIVATE_PATH}}" } } }, {
    ...options, environment: new Map([["PRIVATE_PATH", "/private/secret-bearing-path"]]), readText: async () => { throw new Error("sensitive OS error"); },
  });
  assert.deepEqual(result.providers, {});
  assert.equal(result.errors[0]?.code, "unreadable_file_reference");
  assert.ok(!JSON.stringify(result).includes("secret-bearing-path"));
  assert.ok(!JSON.stringify(result).includes("sensitive OS error"));
});

test("the server-only encryption key cannot be expanded into a provider", async () => {
  const result = await resolveProviderConfigTemplates({ local: { options: { apiKey: "{env:OPENWORK_ENCRYPTION_KEY}" } } }, {
    ...options, inheritedEnvironment: { OPENWORK_ENCRYPTION_KEY: "server-only" },
  });
  assert.deepEqual(result.providers, {});
  assert.equal(result.errors[0]?.code, "missing_environment_variable");
  assert.ok(!JSON.stringify(result).includes("server-only"));
});

for (const url of ["file:///private/config", "https://user:password@proxy.example.test/v1", "not a URL"]) {
  test("resolved endpoints still pass through the native endpoint safety check: " + url.split(":")[0], async () => {
    const result = await resolveProviderConfigTemplates({ local: definition() }, { ...options, environment: new Map([...environment, ["PROVIDER_URL", url]]) });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(mapRuntimeProvidersToV2Specs(result.providers, environment, new Map(), new Set(["local"])).skippedProviderIds, ["local"]);
  });
}
