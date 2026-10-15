import { browserScript, reload } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createOrgDefaultModelWorld } from "./org-default-model.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Real Den plus isolated Electron profiles; no model-selection store is seeded. */
async function desktopDefaults(seed: Seed, featureOn: boolean) {
  const world = await createOrgDefaultModelWorld(seed, { web: true });
  const enabled = await world.setFeature("orgDefaultModel", true);
  if (enabled.status !== 200) throw new Error(`Enabling model defaults failed: ${enabled.text}`);
  const organization = { providerId: world.providerId, modelId: "model-a" };
  const team = { providerId: world.providerId, modelId: "model-b" };
  for (const [path, model] of [
    ["/v1/org/default-model/everyone", organization],
    [`/v1/org/default-model/teams/${world.teams.research}`, team],
  ] as const) {
    const saved = await world.request(world.owner, "PUT", path, { model });
    if (saved.status !== 200) throw new Error(`Saving ${path} failed: ${saved.text}`);
  }
  // The previous desktop default is deliberately different from BOTH managed
  // choices. Nothing calls an upstream provider in this model-selection proof.
  const created = await seed.api(world.owner, "/v1/llm-providers", {
    method: "POST", headers: { "x-openwork-org-id": world.orgId },
    body: JSON.stringify({
      name: "Previous desktop provider", source: "custom", allMembers: true, memberIds: [], teamIds: [],
      apiKey: "sk-default-model-desktop-fixture-only",
      customConfig: { id: "previous-desktop", name: "Previous desktop provider", npm: "@ai-sdk/openai-compatible",
        env: ["PREVIOUS_DESKTOP_API_KEY"], options: { baseURL: "http://127.0.0.1:9/v1" },
        models: [{ id: "previous-default", name: "Previous desktop default" }] },
    }),
  });
  const provider = record(created.body) && record(created.body.llmProvider) ? created.body.llmProvider : null;
  if (!created.response.ok || typeof provider?.id !== "string") throw new Error(`Seeding previous provider failed: ${created.text}`);
  const previous = { providerID: provider.id, modelID: "previous-default" };
  if (!featureOn) {
    const disabled = await world.setFeature("orgDefaultModel", false);
    if (disabled.status !== 200) throw new Error(`Disabling model defaults failed: ${disabled.text}`);
  }
  const launch = async (as: "maya" | "nora") => {
    const workspacePath = join(seed.tmpPath(`model-proof-${as}`), as === "maya" ? "Research" : "Personal");
    await mkdir(workspacePath, { recursive: true });
    const app = await seed.desktop({ den: world.den, as, name: `org-default-${as}`, enterpriseActivated: true,
      workspacePath, env: { OPENWORK_ENGINE_V2_PREVIEW: "1" } });
    // Arrange the member's PREVIOUS app-level preference only, not the answer
    // under test. The real app fetches Den config and creates session selections.
    await seed.evalIn(app, browserScript((model) => {
      const raw = localStorage.getItem("openwork.preferences");
      const preferences = raw ? JSON.parse(raw) : {};
      localStorage.setItem("openwork.preferences", JSON.stringify({ ...preferences, defaultModel: model, modelVariant: null }));
      localStorage.setItem("openwork.defaultModel", `${model.providerID}/${model.modelID}`);
    }, [previous]));
    await reload(app);
    return app;
  };
  const app = await launch("maya");
  const noOverrideApp = featureOn ? await launch("nora") : null;
  return { ...world, app, noOverrideApp, previous, organization, team, featureOn };
}

export function orgDefaultModelDesktop(seed: Seed) { return desktopDefaults(seed, true); }
export function orgDefaultModelDesktopOff(seed: Seed) { return desktopDefaults(seed, false); }
