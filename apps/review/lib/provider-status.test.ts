import assert from "node:assert/strict";
import { test } from "node:test";
import { previewProviderOptions } from "./provider-status.ts";
import { previewAccessUrl } from "./preview-options.ts";
import { parsePreviewOutputs } from "@openwork/freestyle/outputs";

test("server-derived choices cover neither, Freestyle-only, Daytona-only and both credentials", async () => {
  for (const freestyle of [false, true]) for (const daytona of [false, true]) {
    let authorityReads = 0;
    const options = await previewProviderOptions({
      configured: { freestyle: () => freestyle, daytona: () => daytona },
      preferred: () => "freestyle",
      daytonaAccess: async () => { authorityReads++; return { enabled: true }; },
    });
    assert.deepEqual(options.filter((option) => option.connected).map((option) => option.id), [
      ...(freestyle ? ["freestyle"] : []), ...(daytona ? ["daytona"] : []),
    ]);
    assert.equal(authorityReads, daytona ? 1 : 0);
    assert.ok(!JSON.stringify(options).includes("apiKey"));
  }
});

test("off or unverified rollout locks Daytona but preserves configured Freestyle", async () => {
  const options = await previewProviderOptions({ configured: { freestyle: () => true, daytona: () => true }, preferred: () => "daytona",
    daytonaAccess: async () => ({ enabled: false, reason: "The deployment administrator has turned this off." }) });
  assert.equal(options[0].id, "daytona");
  assert.equal(options[0].connected, false);
  assert.match(options[0].reason ?? "", /deployment administrator/);
  assert.equal(options[1].connected, true);
});

test("bad provider configuration fails closed instead of silently selecting another", async () => {
  const options = await previewProviderOptions({ configured: { freestyle: () => true, daytona: () => true },
    preferred: () => { throw new Error("bad config"); }, daytonaAccess: async () => ({ enabled: true }) });
  assert.ok(options.every((option) => !option.connected && option.reason?.includes("misconfigured")));
});

test("provider-specific links reject cross-provider and untrusted access hosts", () => {
  const freestyle = `https://ow-${"a".repeat(32)}.preview.openwork.software/`;
  const desktop = `https://desktop-${"a".repeat(32)}.preview.openwork.software/`;
  const daytona = "https://8080-signed.daytonaproxy01.net/__openwork_launch?token=fixture";
  assert.equal(previewAccessUrl("freestyle", freestyle), true);
  assert.equal(previewAccessUrl("freestyle", desktop, true), true);
  assert.equal(previewAccessUrl("daytona", daytona), true);
  for (const provider of ["freestyle", "daytona"]) {
    // The public predicate accepts only a known provider union.
    for (const bad of ["javascript:alert(1)", "http://example.test", "https://example.test", "https://user:pass@8080-signed.daytonaproxy01.net/", "https://8080-signed.daytonaproxy01.net:444/"]) {
      assert.equal(previewAccessUrl(provider === "freestyle" ? "freestyle" : "daytona", bad), false);
    }
  }
  assert.equal(previewAccessUrl("daytona", freestyle), false);
  assert.equal(previewAccessUrl("freestyle", daytona), false);
  const services = { webUrl: { value: daytona, group: "Services", secret: true } };
  assert.equal(parsePreviewOutputs(services, "daytona").webUrl.value, daytona);
  assert.throws(() => parsePreviewOutputs(services, "freestyle"), /Invalid private service link/);
  assert.throws(() => parsePreviewOutputs({ webUrl: { value: "https://example.test/", group: "Services" } }, "daytona"), /Invalid private service link/);
});
