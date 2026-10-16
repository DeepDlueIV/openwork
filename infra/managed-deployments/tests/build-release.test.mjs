import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const modulePath = "infra/managed-deployments/aws/terraform/modules/openwork-aws-ecs";
// Snapshot from origin/dev at 47dd6753da15a0144011cb00e65e39c0a5f2e9d7.
// Pin the complete Git tree, not the moving shared module or a network lookup.
const frozenTree = "e8598102dcf7d5e59db5885949815cf56f4960f1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const objectHash = (kind, bytes) => createHash("sha1")
  .update(Buffer.from(`${kind} ${bytes.length}\0`)).update(bytes).digest();

function treeHash(directory) {
  const entries = readdirSync(directory).map((name) => {
    const path = join(directory, name);
    const info = lstatSync(path);
    assert.equal(info.isSymbolicLink(), false, "Frozen sources cannot be symlinks");
    assert.ok(info.isFile() || info.isDirectory());
    const directoryEntry = info.isDirectory();
    return {
      sortKey: Buffer.from(name + (directoryEntry ? "/" : "")),
      entry: Buffer.concat([
        Buffer.from(`${directoryEntry ? "40000" : "100644"} ${name}\0`),
        directoryEntry ? treeHash(path) : objectHash("blob", readFileSync(path)),
      ]),
    };
  }).sort((left, right) => Buffer.compare(left.sortKey, right.sortKey));
  return objectHash("tree", Buffer.concat(entries.map(({ entry }) => entry)));
}

test("managed AWS implementation stays byte-identical to its pinned pre-contract snapshot", () => {
  assert.equal(treeHash(resolve(root, modulePath)).toString("hex"), frozenTree,
    "Changing the frozen implementation requires a separately reviewed installer adoption");
  const main = readFileSync(resolve(root, "infra/managed-deployments/aws/terraform/main.tf"), "utf8");
  assert.match(main, /source\s*=\s*"\.\/modules\/openwork-aws-ecs"/);
  assert.doesNotMatch(main, /source\s*=\s*"\.\.\/\.\.\/\.\.\/terraform\/modules\/openwork-aws-ecs"/);
  assert.doesNotMatch(main, /write_only_secrets/);
});

test("installer archive contains only the frozen operational module, with identical file bytes", () => {
  const output = mkdtempSync(join(tmpdir(), "openwork-frozen-installer-test-"));
  try {
    execFileSync(process.execPath, [resolve(root, "infra/managed-deployments/tools/build-release.mjs"), "aws", "0.18.58", output], { cwd: root });
    const bundle = join(output, "bundle.tar.gz");
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.bundleSha256, sha256(readFileSync(bundle)));
    const release = JSON.parse(execFileSync("tar", ["-xOf", bundle, "release.json"], { encoding: "utf8" }));
    const names = Object.keys(release.files);
    // Python lists raw members; macOS tar can hide AppleDouble sidecars.
    const archiveNames = JSON.parse(execFileSync("python3", ["-c",
      "import json,sys,tarfile; a=tarfile.open(sys.argv[1]); print(json.dumps([e.name for e in a.getmembers() if e.isfile()]))", bundle], { encoding: "utf8" }));
    assert.deepEqual(archiveNames.sort(), [...names, "release.json"].sort());
    const expected = readdirSync(resolve(root, modulePath)).filter((name) => name.endsWith(".tf")).map((name) => `${modulePath}/${name}`).sort();
    assert.equal(expected.length, 10);
    assert.deepEqual(names.filter((name) => name.startsWith(modulePath + "/")).sort(), expected);
    assert.equal(names.some((name) => name.startsWith("infra/terraform/modules/openwork-aws-ecs/")), false);
    assert.equal(names.some((name) => name.includes("/examples/") || name.includes("/tests/")), false);
    for (const name of expected) {
      const source = readFileSync(resolve(root, name));
      const packaged = execFileSync("tar", ["-xOf", bundle, name]);
      assert.deepEqual(packaged, source, name);
      assert.equal(release.files[name], sha256(source), name);
    }
    const packagedMain = execFileSync("tar", ["-xOf", bundle, "infra/managed-deployments/aws/terraform/main.tf"], { encoding: "utf8" });
    assert.match(packagedMain, /source\s*=\s*"\.\/modules\/openwork-aws-ecs"/);
    assert.equal(names.some((name) => /\.(?:tfstate|tfvars|tfplan)(?:\.|$)/.test(name)), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
