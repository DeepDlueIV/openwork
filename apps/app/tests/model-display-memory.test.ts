import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readModelDisplayMemory, rememberModelDisplayNames } from "../src/react-app/domains/session/surface/model-display-memory";
import { closestAvailableModel } from "../src/react-app/domains/session/surface/model-removal";
import type { ModelOption } from "../src/app/types";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
afterEach(() => window.localStorage.removeItem("openwork.modelDisplayMemory.v1"));
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
const model = { providerID: "ipr_fixture", modelID: "gwm_opus", title: "Claude Opus 4.5" };

test("cold-start names and maker survive removal without crossing an identity scope", () => {
  rememberModelDisplayNames("member-a/workspace", new Map(), [model]);
  const remembered = readModelDisplayMemory("member-a/workspace").get("ipr_fixture/gwm_opus");
  expect(remembered).toEqual(model);
  expect(readModelDisplayMemory("member-b/workspace").size).toBe(0);
  const option = (modelID: string, title: string): ModelOption => ({
    providerID: "ipr_fixture", modelID, title, description: "Gateway", behaviorTitle: "Reasoning",
    behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null, isFree: false,
  });
  const luna = option("gwm_luna", "GPT-6 Luna");
  const sonnet = option("gwm_sonnet", "Claude Sonnet 4.5");
  if (!remembered) throw new Error("Display memory is missing");
  expect(closestAvailableModel([luna, sonnet], [luna], [], remembered, () => true)).toEqual(sonnet);
});

test("only bounded public identity/title metadata is retained", () => {
  const memory = new Map();
  rememberModelDisplayNames("scope", memory, [model, { providerID: "ipr_opaque", modelID: "gwm_opaque", title: "gwm_opaque" }]);
  expect(readModelDisplayMemory("scope").size).toBe(1);
  expect(window.localStorage.getItem("openwork.modelDisplayMemory.v1")).not.toContain("description");
  rememberModelDisplayNames("scope", memory, Array.from({ length: 250 }, (_, index) => ({ providerID: "local", modelID: `id-${index}`, title: `Model ${index}` })));
  expect(readModelDisplayMemory("scope").size).toBe(200);
});

test("malformed storage never becomes a model name or entitlement", () => {
  window.localStorage.setItem("openwork.modelDisplayMemory.v1", "not json");
  expect(readModelDisplayMemory("scope").size).toBe(0);
  window.localStorage.setItem("openwork.modelDisplayMemory.v1", JSON.stringify({ scope: [null, { providerID: 12 }, { providerID: "ipr_x", modelID: "gwm_y", title: "ipr_leaked" }] }));
  expect(readModelDisplayMemory("scope").size).toBe(0);
});
