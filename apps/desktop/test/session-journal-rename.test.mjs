import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renameSessionJournal } from "../electron/session-journal-rename.mjs";

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`Windows retries a transient ${code} without removing the old journal`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "session-journal-rename-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "pending.tmp");
    const destination = join(root, "journal.json");
    await writeFile(source, "new journal");
    await writeFile(destination, "old journal");
    let attempts = 0;
    const delays = [];
    await renameSessionJournal(source, destination, {
      platform: "win32",
      renameImpl: async (from, to) => {
        attempts += 1;
        assert.equal(await readFile(to, "utf8"), "old journal");
        if (attempts < 3) throw Object.assign(new Error("busy"), { code });
        await rename(from, to);
      },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [10, 20]);
    assert.equal(await readFile(destination, "utf8"), "new journal");
  });
}

test("a permanent Windows lock rejects after bounded retries and preserves the old journal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "session-journal-rename-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "pending.tmp");
  const destination = join(root, "journal.json");
  await writeFile(source, "new journal");
  await writeFile(destination, "old journal");
  const failure = Object.assign(new Error("locked"), { code: "EPERM" });
  let attempts = 0;
  const delays = [];
  await assert.rejects(renameSessionJournal(source, destination, {
    platform: "win32",
    renameImpl: async () => { attempts += 1; throw failure; },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  }), (error) => error === failure);
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [10, 20, 50, 100, 200]);
  assert.equal(await readFile(destination, "utf8"), "old journal");
  assert.equal(await readFile(source, "utf8"), "new journal");
});

for (const platform of ["linux", "darwin"]) {
  test(`${platform} does not retry filesystem errors`, async () => {
    const failure = Object.assign(new Error("denied"), { code: "EPERM" });
    let attempts = 0;
    await assert.rejects(renameSessionJournal("pending.tmp", "journal.json", {
      platform,
      renameImpl: async () => { attempts += 1; throw failure; },
      sleep: async () => assert.fail("Unexpected retry"),
    }), (error) => error === failure);
    assert.equal(attempts, 1);
  });
}

test("Windows does not retry unrelated errors", async () => {
  const failure = Object.assign(new Error("missing"), { code: "ENOENT" });
  let attempts = 0;
  await assert.rejects(renameSessionJournal("pending.tmp", "journal.json", {
    platform: "win32",
    renameImpl: async () => { attempts += 1; throw failure; },
    sleep: async () => assert.fail("Unexpected retry"),
  }), (error) => error === failure);
  assert.equal(attempts, 1);
});
