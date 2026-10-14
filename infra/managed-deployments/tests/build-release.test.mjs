import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRelease, GCP_REPOSITORIES, HEALTH_SOURCE, resolveGcpImages } from "../tools/build-release.mjs";

const digest = (character) => "sha256:" + character.repeat(64);
const metadata = (character, os = "linux", architecture = "amd64") => ({
  Descriptor: { digest: digest(character), platform: { os, architecture } },
  SchemaV2Manifest: { config: { digest: digest("d") } },
});
const pins = { den_api: GCP_REPOSITORIES.den_api + "@" + digest("a"), den_web: GCP_REPOSITORIES.den_web + "@" + digest("b") };
const inspect = (source) => metadata(source.includes("openwork-den-api") ? "a" : source.includes("openwork-den-web") ? "b" : "c");

test("operator resolves exact published tags and re-verifies Linux/amd64 child digests", () => {
  const calls = [];
  const images = resolveGcpImages("0.18.0", undefined, (ref) => {
    calls.push(ref);
    const selected = inspect(ref);
    return ref.includes("@") && ref !== HEALTH_SOURCE ? selected
      : [metadata("e", "linux", "arm64"), metadata("f", "unknown", "unknown"), selected];
  });
  assert.deepEqual(images, { ...pins, health: GCP_REPOSITORIES.health + "@" + digest("c") });
  assert.deepEqual(calls, [GCP_REPOSITORIES.den_api + ":0.18.0", pins.den_api,
    GCP_REPOSITORIES.den_web + ":0.18.0", pins.den_web, HEALTH_SOURCE, images.health]);
});

test("Docker OCIManifest metadata is supported as well as schema-v2 metadata", () => {
  const images = resolveGcpImages("0.18.0", undefined, (source) => {
    const entry = inspect(source);
    entry.OCIManifest = entry.SchemaV2Manifest;
    delete entry.SchemaV2Manifest;
    return entry;
  });
  assert.deepEqual(images, { ...pins, health: GCP_REPOSITORIES.health + "@" + digest("c") });
});

test("explicit approved pins are verified, never accepted offline by production builder", () => {
  const calls = [];
  assert.deepEqual(resolveGcpImages("0.18.0", pins, (ref) => { calls.push(ref); return inspect(ref); }),
    { ...pins, health: GCP_REPOSITORIES.health + "@" + digest("c") });
  assert.equal(calls[0], pins.den_api);
  assert.equal(calls[1], pins.den_api);
  assert.throws(() => resolveGcpImages("0.18.0", pins, () => { throw new Error("registry pin not found"); }), /not found/);
});

test("missing, mutable, wrong-repository and unexpected approved pin inventories fail closed", () => {
  for (const candidate of [null, [], {}, { den_api: pins.den_api }, { ...pins, health: HEALTH_SOURCE },
    { ...pins, den_api: GCP_REPOSITORIES.den_api + ":0.18.0" },
    { ...pins, den_api: "evil.test/api@" + digest("a") }, { ...pins, den_api: pins.den_web },
    { ...pins, den_api: pins.den_api + "\n" }, { ...pins, den_api: pins.den_api.toUpperCase() }]) {
    let contacted = false;
    assert.throws(() => resolveGcpImages("0.18.0", candidate, (ref) => { contacted = true; return inspect(ref); }));
    assert.equal(contacted, false);
  }
});

test("unavailable/ambiguous platforms and invalid registry digests cannot produce pins", () => {
  const malformed = metadata("a");
  malformed.Descriptor.digest = "sha256:" + "G".repeat(64);
  for (const response of [[], {}, metadata("a", "linux", "arm64"),
    [metadata("a"), metadata("b")], malformed, { ...metadata("a"), SchemaV2Manifest: undefined }]) {
    assert.throws(() => resolveGcpImages("0.18.0", undefined, () => response), /Linux\/amd64/);
  }
});

test("registry re-verification and approved manifest identity must match", () => {
  let count = 0;
  assert.throws(() => resolveGcpImages("0.18.0", undefined, () => metadata(++count === 1 ? "a" : "b")), /Registry digest mismatch/);
  assert.throws(() => resolveGcpImages("0.18.0", { ...pins, den_api: GCP_REPOSITORIES.den_api + "@" + digest("e") }, inspect), /Approved pin/);
});

test("AWS release architecture does not invoke Docker or add GCP image inventory", () => {
  const output = mkdtempSync(join(tmpdir(), "openwork-aws-build-test-"));
  try {
    buildRelease(["aws", "0.18.0", output]);
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.provider, "aws");
    const release = JSON.parse(execFileSync("tar", ["-xOf", join(output, "bundle.tar.gz"), "release.json"], { encoding: "utf8" }));
    assert.equal(release.provider, "aws");
    assert.equal(release.images, undefined);
    assert.ok(release.files["infra/managed-deployments/aws/runner/runner.py"]);
    assert.equal(Object.keys(release.files).some((file) => file.includes("/gcp/")), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("GCP CLI cannot disable registry verification or use unsupported options", () => {
  const script = new URL("../tools/build-release.mjs", import.meta.url).pathname;
  for (const args of [["gcp", "latest"], ["gcp", "0.18.0", "/unused", "--skip-verification"],
    ["aws", "0.18.0", "/unused", "--image-pins", "/unused"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
  }
});
