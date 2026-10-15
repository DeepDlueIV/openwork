import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = new URL("../../infra/terraform/modules/openwork-azure-container-apps/", import.meta.url).pathname;

test("Azure migration observer waits for the exact execution and fails closed without starting or retrying jobs", async ({ evidence }) => {
  const temporary = mkdtempSync(join(tmpdir(), "azure-migration-observer-"));
  const execution = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.App/jobs/test/executions/exact";
  try {
    writeFileSync(join(temporary, "az"), '#!/bin/sh\ncase "$*" in *"--method get"*"jobs/test/executions/exact"*) ;; *) exit 7;; esac\nprintf \'"%s"\\n\' "$OBSERVER_STATUS"\n', { mode: 0o700 });
    for (const status of ["Succeeded", "Failed", "Stopped"]) {
      const result = spawnSync("python3", [join(directory, "scripts/wait-for-migration.py")], {
        input: JSON.stringify({ execution_id: execution, timeout: "120" }), encoding: "utf8",
        env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, OBSERVER_STATUS: status },
      });
      expect(result.status).toBe(status === "Succeeded" ? 0 : 1);
      if (status === "Succeeded") expect(JSON.parse(result.stdout)).toEqual({ status, execution_id: execution });
      else expect(result.stdout).toBe("");
    }
    const rejected = spawnSync("python3", [join(directory, "scripts/wait-for-migration.py")], { input: JSON.stringify({ execution_id: "https://untrusted.example", timeout: "120" }), encoding: "utf8" });
    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toBe("");
    const deadline = spawnSync("python3", ["-c", `
import runpy, subprocess, sys
from unittest.mock import patch
module = runpy.run_path(sys.argv[1])
with patch('time.monotonic', side_effect=[0, 0, 121, 121]), patch('time.sleep'), patch('subprocess.run', return_value=subprocess.CompletedProcess([], 0, stdout='"Running"')) as observer:
    try:
        module['main']()
        raise AssertionError('Running must not promote a release')
    except RuntimeError as error:
        assert 'deadline exceeded' in str(error)
        assert observer.call_count == 1
        assert '--method' in observer.call_args.args[0]
        assert 'get' in observer.call_args.args[0]
        print('deadline failed closed')
`, join(directory, "scripts/wait-for-migration.py")], { input: JSON.stringify({ execution_id: execution, timeout: "120" }), encoding: "utf8" });
    expect(deadline.status, deadline.stderr).toBe(0);
    expect(deadline.stdout.trim()).toBe("deadline failed closed");
    evidence.recordAssertionEvidence("Read-only completion observer", "Only GET of the native start's exact ARM execution is allowed by the witness. Succeeded returns identity; Failed/Stopped and a non-ARM URL produce no successful result. A Running execution times out without promotion or another start. No start or retry command is issued.", true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
