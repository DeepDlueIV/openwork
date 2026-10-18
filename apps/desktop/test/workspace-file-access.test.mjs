import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveWorkspaceFileLaunch } from "../electron/workspace-file-access.mjs";

test("native file launching uses real files and real workspace containment", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-file-safety-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const inside = join(workspace, "report.pdf");
  const outside = join(root, "outside.pdf");
  await writeFile(inside, "%PDF-1.7\n");
  await writeFile(outside, "%PDF-1.7\n");
  try {
    const existing = await resolveWorkspaceFileLaunch(workspace, inside);
    assert.equal(existing.ok, true);
    assert.equal((await resolveWorkspaceFileLaunch(workspace, join(workspace, "missing.pdf"))).reason, "missing");
    assert.equal((await resolveWorkspaceFileLaunch(workspace, outside)).reason, "outside");
    assert.equal((await resolveWorkspaceFileLaunch(workspace, workspace)).reason, "outside");
    await mkdir(join(workspace, "folder"));
    assert.equal((await resolveWorkspaceFileLaunch(workspace, join(workspace, "folder"))).reason, "not-file");
    const escaping = join(workspace, "escape.pdf");
    await symlink(outside, escaping);
    assert.equal((await resolveWorkspaceFileLaunch(workspace, escaping)).reason, "outside");
    const internal = join(workspace, "internal.pdf");
    await symlink(inside, internal);
    assert.equal((await resolveWorkspaceFileLaunch(workspace, internal)).ok, true);
    const linkedRoot = join(root, "linked-workspace");
    await symlink(workspace, linkedRoot);
    assert.equal((await resolveWorkspaceFileLaunch(linkedRoot, join(linkedRoot, "report.pdf"))).ok, true);
    if (process.platform !== "win32") {
      assert.equal((await resolveWorkspaceFileLaunch("C:\\workspace", "C:\\workspace\\report.pdf")).reason, "invalid");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
