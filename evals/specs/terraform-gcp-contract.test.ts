import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const test = spec.world(async () => ({}), {
  resources: { surfaces: [], services: [] },
  needs: { commands: ["terraform", "tofu"] },
  timeout: 600_000,
});
const source = fileURLToPath(new URL("../../infra/terraform/modules/openwork-gcp-cloud-run", import.meta.url));

for (const tool of ["terraform", "tofu"]) {
  test(`GCP contract validates and executes offline with ${tool}`, async ({ evidence }) => {
    const root = await mkdtemp(join(tmpdir(), "openwork-gcp-contract-"));
    const module = join(root, "module");
    try {
      await cp(source, module, {
        recursive: true,
        filter: (path) => basename(path) !== ".terraform" && !(basename(path) === ".terraform.lock.hcl" && path === join(source, ".terraform.lock.hcl")),
      });
      function run(args: string[], cwd = module) {
        return execFileSync(tool, args, { cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TF_IN_AUTOMATION: "1" } });
      }
      run(["init", "-backend=false", "-input=false", "-no-color"]);
      run(["init", "-backend=false", "-input=false", "-lockfile=readonly", "-no-color"]);
      expect(run(["validate", "-no-color"])).toContain("valid");
      const result = run(["test", "-no-color"]);
      expect(result).toMatch(/Success! \d+ passed, 0 failed/);
      expect(result).not.toContain("... skip");
      const example = join(module, "examples/complete");
      if (tool === "tofu") {
        // Explicit registry migration of a copied ROOT lock, never the shipped file.
        await rm(join(example, ".terraform.lock.hcl"));
        run(["init", "-backend=false", "-input=false", "-no-color"], example);
      }
      run(["init", "-backend=false", "-input=false", "-lockfile=readonly", "-no-color"], example);
      expect(run(["validate", "-no-color"], example)).toContain("valid");
      evidence.recordAssertionEvidence(`${tool}: GCP module contract and root lock`, `${tool}: init, read-only init, validate and all mocked-Google contract tests passed without skips; complete example validates with its selected registry lock. No cloud operations.`, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
