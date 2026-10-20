import { rename } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const WINDOWS_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WINDOWS_RETRY_DELAYS_MS = [10, 20, 50, 100, 200];

// Readers and scanners can briefly hold the destination open on Windows.
// Retry the atomic replacement, never unlink/truncate the committed journal.
// Persistent failures still reach the runner, which stops rather than replaying.
export async function renameSessionJournal(from, to, options = {}) {
  const renameImpl = options.renameImpl ?? rename;
  const sleep = options.sleep ?? setTimeout;
  const delays = (options.platform ?? process.platform) === "win32"
    ? WINDOWS_RETRY_DELAYS_MS
    : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !WINDOWS_RETRY_CODES.has(error?.code)) throw error;
      await sleep(delay);
    }
  }
}
