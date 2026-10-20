// Temporary CI probe: observe atomic journal replacement without retrying,
// suppressing errors, changing timeouts, or logging journal contents.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

const originalRename = fs.promises.rename;
const stats = { calls: 0, failures: 0, slowestMs: 0 };
fs.promises.rename = async function diagnosticRename(from, to) {
  const fixture = String(to).includes("openwork-session-runner-");
  const started = performance.now();
  try {
    return await originalRename(from, to);
  } catch (error) {
    if (fixture) {
      stats.failures += 1;
      console.error("[journal-fs-diagnostic]", error.code, error.syscall, error.message);
    }
    throw error;
  } finally {
    if (fixture) {
      stats.calls += 1;
      stats.slowestMs = Math.max(stats.slowestMs, Math.round(performance.now() - started));
    }
  }
};
syncBuiltinESMExports();
process.on("exit", () => console.error("[journal-fs-diagnostic]", JSON.stringify(stats)));
