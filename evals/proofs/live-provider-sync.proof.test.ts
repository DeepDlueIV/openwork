import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { liveProviderSync } from "../worlds/live-provider-sync.ts";

const test = spec.world(liveProviderSync, {
  resources: { surfaces: ["appWeb"], services: ["den"] },
  needs: { commands: ["bun", "opencode2"] }, timeout: 480_000,
});

// The admin action uses Den's authenticated management API, not the Den web UI.
// This proves real database -> inventory stream -> v2 catalog -> open picker.
test("a member sees an administrator's newly enabled model without refreshing their open picker", async ({ world, user, probe, step, evidence }) => {
  let documentIdentity = 0;
  await step("before: the member's open picker offers only the model already enabled by their administrator", async () => {
    await user.see("composer", { editable: true });
    await user.click("Change model");
    await probe.eventually(() => world.runtime(), {
      within: 60_000, label: "the signed-in organization enables live model updates",
      until: (status) => status.chatRouting === true && status.liveProviderSync === true,
    });
    await probe.eventually(() => probe.dom(world.pickerRows), {
      within: 60_000, label: "the initial organization model is available", until: (rows) => rows.elements.length === 1,
    });
    documentIdentity = await world.documentIdentity();
    const rows = await probe.dom(world.pickerRows);
    expect(rows.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("The real signed-in v2 app has one organization model before the admin's change", `${rows.elements.length} managed row; ordinary provider polling is set to 600000 ms.`, rows.elements.length === 1);
    await user.screenshot();
  });

  await step("after: the administrator adds a model and it appears in the same open picker within five seconds", async () => {
    const update = await world.addModel();
    expect(update.body).toMatchObject({ addedModelIds: [world.addedModel] });
    await probe.eventually(() => probe.dom(world.pickerRows), {
      within: 5_000, label: "the added model arrives without a refresh", until: (rows) => rows.elements.length === 2,
    });
    const elapsedMs = Date.now() - update.startedAt;
    expect(elapsedMs).toBeLessThanOrEqual(5_000);
    expect(await world.documentIdentity()).toBe(documentIdentity);
    await user.see({ testId: "composer-model-picker" });
    evidence.recordAssertionEvidence("A real admin write reaches the open picker without refresh or periodic polling", `POST enable-models returned ${update.status}; both organization models appeared in ${elapsedMs} ms; the browser document is unchanged.`, elapsedMs <= 5_000);
    await user.screenshot();
  });

  await step("disabling the provider removes its models without refreshing the member's picker", async () => {
    const update = await world.disableProvider();
    await probe.eventually(() => probe.dom(world.pickerRows), {
      within: 5_000, label: "disabled organization models stop being offered", until: (rows) => rows.elements.length === 0,
    });
    const elapsedMs = Date.now() - update.startedAt;
    expect(elapsedMs).toBeLessThanOrEqual(5_000);
    expect(await world.documentIdentity()).toBe(documentIdentity);
    await user.see({ testId: "composer-model-picker" });
    evidence.recordAssertionEvidence("Live updates cannot leave disabled organization models selectable", `PATCH disabled returned ${update.status}; zero organization rows remain after ${elapsedMs} ms; the browser document is unchanged.`, elapsedMs <= 5_000);
    await user.screenshot();
  });
});
