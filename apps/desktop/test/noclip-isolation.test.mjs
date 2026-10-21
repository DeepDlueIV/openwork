import assert from "node:assert/strict";
import test from "node:test";
import { resolveDesktopDistribution } from "../electron/desktop-distribution.mjs";

test("packaged NoClip has its own app identity and URI scheme", () => {
  const actual = resolveDesktopDistribution({
    isPackaged: true,
    packageFlavor: "noclip",
    environmentFlavor: "public",
  });
  assert.equal(actual.appName, "NoClip");
  assert.equal(actual.appIdentifier, "io.github.deepdlueiv.noclip");
  assert.equal(actual.protocolScheme, "noclip");
  assert.equal(actual.flavor, "public");
  assert.equal(actual.requireActivation, false);
});
