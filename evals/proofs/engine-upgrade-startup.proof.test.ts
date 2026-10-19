import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { engineUpgradeStartup } from "../worlds/engine-upgrade-startup.ts";

const test = spec.world(engineUpgradeStartup, {
  timeout: 240000,
  resources: { surfaces: ["desktop"], services: ["den"], nativeReason: "The optional upgrade must discover the embedded host after a delayed desktop startup." },
  needs: { placement: "local" },
});

test("the optional chat upgrade appears when the local host starts after organization features resolve", async ({ world, user, probe, step, evidence }) => {
  await step("the existing v1 profile offers an upgrade after its delayed host becomes ready", async () => {
    expect(await world.authStatus()).toMatchObject({ status: "signed_in" });
    const status = await probe.eventually(() => world.status(), { within: 60000, until: value => value.v1HistoryAvailable === true, label: "the delayed host can read the existing v1 history" });
    expect(status).toMatchObject({ chatRouting: false, v1HistoryAvailable: true });
    await user.on(world.app).see({ testId: "engine-upgrade-notice" }, { timeoutMs: 65000 });
    await user.on(world.app).screenshot();
    evidence.recordAssertionEvidence("The optional offer survives a delayed host startup", "An authenticated profile with persisted v1 history sees the organization-enabled notice without a renderer reload. Routing remains on v1.", true);
  });
  await step("declining the consent does not start a history copy or switch engines", async () => {
    await user.on(world.app).click({ role: "button", text: /^Upgrade$/ });
    await user.on(world.app).see({ testId: "engine-migration-consent" });
    await user.on(world.app).click({ role: "button", text: /^Cancel$/ });
    await user.on(world.app).notSee({ testId: "engine-migration-consent" });
    expect(await world.status()).toMatchObject({ chatRouting: false, migration: { state: "idle" } });
    await user.on(world.app).screenshot();
    evidence.recordAssertionEvidence("Consent remains required", "Cancel leaves v1 routing and the idle migration unchanged; startup retry does not migrate automatically.", true);
  });
});
