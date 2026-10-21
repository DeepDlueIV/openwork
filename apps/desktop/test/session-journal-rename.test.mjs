import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
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

test("a Windows sharing lock lasting 600 ms does not poison the journal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "session-journal-rename-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "pending.tmp");
  const destination = join(root, "journal.json");
  await writeFile(source, "new journal");
  await writeFile(destination, "old journal");
  let elapsed = 0;
  await renameSessionJournal(source, destination, {
    platform: "win32",
    renameImpl: async (from, to) => {
      assert.equal(await readFile(to, "utf8"), "old journal");
      if (elapsed < 600) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
      await rename(from, to);
    },
    sleep: async (milliseconds) => { elapsed += milliseconds; },
  });
  assert.ok(elapsed >= 600 && elapsed <= 2_000);
  assert.equal(await readFile(destination, "utf8"), "new journal");
});

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
  assert.equal(attempts, 8);
  assert.deepEqual(delays, [10, 20, 50, 100, 200, 400, 800]);
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

// Exercise an actual Windows sharing violation, not only error injection.
// The child is a test fixture: its handle denies delete/rename for 600 ms.
test("Windows replaces the journal after a real reader releases its handle", {
  skip: process.platform !== "win32", timeout: 10_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "session-journal-reader-"));
  const source = join(root, "pending.tmp");
  const destination = join(root, "journal.json");
  await writeFile(source, "new journal");
  await writeFile(destination, "old journal");
  const script = "$h=[IO.File]::Open($env:JOURNAL_FIXTURE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); try { [Console]::WriteLine('READY'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 600 } finally { $h.Dispose() }";
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, JOURNAL_FIXTURE: destination },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await closed;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Reader fixture did not become ready")), 5_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); if (!output.includes("READY")) reject(new Error("Reader exited before opening file")); });
    child.stdout.on("data", (data) => {
      output += data;
      if (output.includes("READY")) { clearTimeout(timer); resolve(); }
    });
  });
  await renameSessionJournal(source, destination);
  assert.equal((await closed)[0], 0);
  assert.equal(await readFile(destination, "utf8"), "new journal");
});
