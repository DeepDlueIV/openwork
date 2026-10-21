import { rename } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const WINDOWS_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
// CI reproduced sharing violations surviving the original 380 ms window.
// Allow 1.58 s of bounded backoff for reader/scanner handles to close. This
// retries only atomic rename; it never removes/truncates the old journal.
const WINDOWS_RETRY_DELAYS_MS = [10, 20, 50, 100, 200, 400, 800];

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
