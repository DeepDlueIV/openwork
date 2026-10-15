import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { reliableRecoveryWorld } from "../worlds/first-run.ts";

const test = spec.world(reliableRecoveryWorld, { timeout: 300_000 });
const catalogTest = spec.world((seed, context) => reliableRecoveryWorld(seed, context, { catalog: true }), { timeout: 300_000 });
const verifiedArtifact = "https://releases.openwork.test/v1.8.2/OpenWork-darwin-arm64.dmg";
const currentArtifact = "https://releases.openwork.test/v2.4.0/OpenWork-darwin-arm64.dmg";
const previousArtifact = "https://releases.openwork.test/v2.3.1/OpenWork-darwin-arm64.dmg";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : null;
}

test("a fatal desktop bootstrap failure offers one-click verified recovery without losing the profile", async ({ world, user, probe, step }) => {
  await step("the recovery screen replaces the failed start and keeps the profile", async () => {
    await user.see({ text: /OpenWork (couldn't|could not) start/i });
    await user.see("Restore previous version");
    await user.see({ role: "button", label: /^reload$/i });
    await user.notSee({ text: /EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE|invalid code signature/ });
    await user.notSee({ text: /GitHub|open an issue|download.*manually/i });
    expect(await world.workspaceNames()).toContain("reliable-recovery-profile-marker");
  });

  await step("only the verified previous version is offered", async () => {
    await user.click("Pick another version");
    await user.see("Use 1.8.2");
    await user.notSee({ text: /1\.8\.1|tampered\.invalid/ });
    const initial = await world.snapshot();
    const candidates = field(initial, "candidates");
    expect(Array.isArray(candidates) ? candidates.map((entry) => field(entry, "version")) : []).toEqual(["1.8.2"]);
    expect(field(initial, "installRequests")).toEqual([]);
  });

  await step("one click restores the verified previous version without quitting first", async () => {
    await user.click("Restore previous version");
    const requests = await probe.eventually(async () => field(await world.snapshot(), "installRequests"), {
      within: 5_000, label: "verified previous recovery install intent", until: (value) => Array.isArray(value) && value.length === 1,
    });
    expect(requests).toEqual([{ version: "1.8.2", artifactUrl: verifiedArtifact }]);
    expect(field(await world.snapshot(), "quitRequested")).toBe(false);
  });
});

catalogTest("recovery offers only recent stable releases with exact compatible artifacts", async ({ world, user, probe, step }) => {
  await step("the picker lists only stable builds for this platform and flavor", async () => {
    await user.see({ text: /OpenWork (couldn't|could not) start/i });
    await user.click("Pick another version");
    await user.see({ text: /2\.4\.0\s+current/i });
    await user.see({ text: /Use 2\.3\.1\s+previous/i });
    await user.notSee({ text: /Use 2\.4\.0/i });
    await user.notSee({ text: /2\.3\.0|2\.2\.9|2\.2\.8-beta\.1/ });
    expect(field(await world.snapshot(), "openedArtifactUrls")).toEqual([]);
  });

  await step("choosing the previous release opens its exact compatible installer", async () => {
    await user.click("Use 2.3.1");
    const opened = await probe.eventually(async () => field(await world.snapshot(), "openedArtifactUrls"), {
      within: 5_000, label: "exact compatible release artifact", until: (urls) => Array.isArray(urls) && urls.length === 1,
    });
    expect(opened).toEqual([previousArtifact]);
    expect(opened).not.toContain(currentArtifact);
  });
});
