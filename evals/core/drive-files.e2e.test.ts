import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { driveFiles, inventoryExport, supplierWorkbook } from "../worlds/drive-files.ts";

const SHEET = "application/vnd.google-apps.spreadsheet";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Browser-less: the real desktop host and Cloud gateway move file bytes; the agent's tool calls are made directly.
const test = spec.world(driveFiles, { resources: { surfaces: [], services: ["den"] }, needs: { commands: ["bun", "pnpm"], placement: "local" }, timeout: 600_000 });
test("an agent pulls a Drive file into the workspace, edits it with bash and saves it back without the file entering its context", async ({ world, step, evidence }) => {
  const supplierPath = "drive/Supplier entry.xlsx";
  const capability = (operation: string) => `native:${world.fullId}:${operation}`;
  const driveFile = async (id: string) => {
    const file = (await world.google.driveFiles(world.accounts.member)).find((entry) => entry.id === id);
    if (!file) throw new Error(`Drive file ${id} missing`);
    return { ...file, bytes: Buffer.from(file.contentBase64, "base64") };
  };

  await step("before: the inline Drive read cannot hand the agent a 9 MiB Excel file", async () => {
    const result = await world.mcp("execute_capability", { name: capability("getCapabilitiesGoogleWorkspaceDriveFile"), path: { fileId: world.files.supplier } });
    const file = world.objects(result).find((entry) => entry.id === world.files.supplier && "contentUnavailableReason" in entry);
    expect(file).toMatchObject({ content: null, contentBase64: null, contentUnavailableReason: "file_too_large" });
  });

  await step("the host pulls the file into the workspace and returns only its path and revision", async () => {
    // Only the drive_* engine tools reach these actions, so a push always passes their approval prompt.
    const actions = world.objects(await world.actions()).map((entry) => entry.action);
    expect(actions).toContain("drive_upload_file");
    expect(actions).not.toEqual(expect.arrayContaining(["drive_pull_file"]));
    expect(actions).not.toEqual(expect.arrayContaining(["drive_push_file"]));
    const pulled = await world.host("drive_pull_file", { fileId: `https://docs.google.com/spreadsheets/d/${world.files.supplier}/edit?rtpof=true`, connectionId: world.fullId });
    expect(pulled.status, JSON.stringify(pulled.body)).toBe(200);
    expect(pulled.body).toMatchObject({ ok: true, path: supplierPath, size: supplierWorkbook.byteLength, mimeType: XLSX, file: { id: world.files.supplier, revision: "rev-1" } });
    expect(JSON.stringify(pulled.body).length).toBeLessThan(1_000);
    expect((await world.read(supplierPath)).equals(supplierWorkbook)).toBe(true);
    expect(await world.contentRequests(world.files.supplier)).toBe(2);
    const again = await world.host("drive_pull_file", { fileId: world.files.supplier, connectionId: world.fullId });
    expect(again.body).toMatchObject({ ok: true, upToDate: true, path: supplierPath, file: { revision: "rev-1" } });
    expect(await world.contentRequests(world.files.supplier)).toBe(2);
  });

  await step("a read-only host refuses every pull before downloading or changing a file", async () => {
    const downloads = await world.contentRequests(world.files.supplier);
    const approvals = world.approvals().length;
    for (const overwrite of [false, true]) {
      const denied = await world.readOnlyHost("drive_pull_file", { fileId: world.files.supplier, connectionId: world.fullId, path: "read-only-blocked.xlsx", overwrite });
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: "read_only" });
    }
    expect((await world.bash("test ! -e read-only-blocked.xlsx")).code).toBe(0);
    expect(await world.contentRequests(world.files.supplier)).toBe(downloads);
    expect(world.approvals().length).toBe(approvals);
    expect((await world.readOnlyHost("drive_file_status", {})).body).toMatchObject({ ok: true, files: [] });
  });

  await step("bash edits the local copy and status reports the unpushed edit", async () => {
    const edit = await world.bash(`printf 'row 12: Acme Supplies' | dd of='${supplierPath}' bs=1 seek=4096 conv=notrunc 2>/dev/null`);
    expect(edit.code, edit.stderr).toBe(0);
    const status = await world.host("drive_file_status", { path: supplierPath });
    expect(status.body).toMatchObject({ ok: true, files: [{ path: supplierPath, fileId: world.files.supplier, local: "edited", drive: "unchanged", revision: "rev-1" }] });
  });

  await step("a swapped destination folder cannot redirect downloaded bytes outside the workspace", async () => {
    const downloads = await world.contentRequests(world.files.supplier);
    await world.pullFolderRace();
    const refused = await world.host("drive_pull_file", { fileId: world.files.supplier, connectionId: world.fullId, path: "racing/Supplier.xlsx" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "local_changes" });
    expect(world.folderSwaps()).toBe(1);
    expect(await world.contentRequests(world.files.supplier)).toBeGreaterThan(downloads);
    expect(await world.readRaceOutside()).toBe("outside file stays untouched");
  });

  await step("connected clients cannot bypass the save approval with a direct call", async () => {
    world.setApproval(false);
    const approvalsBefore = world.approvals().length;
    const before = await driveFile(world.files.supplier);
    const fileCount = (await world.google.driveFiles(world.accounts.member)).length;
    const local = await world.read(supplierPath);
    for (const scope of ["owner", "collaborator", "viewer"] as const) {
      for (const mode of ["replace", "copy"]) {
        const denied = await world.direct("drive_push_file", { path: supplierPath, mode }, scope);
        expect(denied.status).toBe(scope === "viewer" ? 403 : 404);
        const direct = await world.direct("drive_push_file", { path: supplierPath, mode }, scope, true);
        expect(direct.status).toBe(403);
        if (scope !== "viewer") expect(direct.body).toMatchObject({ code: "drive_write_denied" });
      }
      expect((await world.direct("drive_pull_file", { fileId: world.files.supplier, path: supplierPath, overwrite: true }, scope)).status).toBe(scope === "viewer" ? 403 : 404);
      const overwrite = await world.direct("drive_pull_file", { fileId: world.files.supplier, connectionId: world.fullId, path: supplierPath, overwrite: true }, scope, true);
      expect(overwrite.status).toBe(403);
      if (scope !== "viewer") expect(overwrite.body).toMatchObject({ code: "drive_write_denied" });
      const download = await world.direct("drive_pull_file", { fileId: world.files.supplier, connectionId: world.fullId, path: "unapproved-read.xlsx" }, scope, true);
      expect(download.status).toBe(403);
      if (scope !== "viewer") expect(download.body).toMatchObject({ code: "drive_write_denied" });
    }
    const after = await driveFile(world.files.supplier);
    expect([after.revision, after.bytes.equals(before.bytes)]).toEqual([before.revision, true]);
    expect((await world.google.driveFiles(world.accounts.member)).length).toBe(fileCount);
    expect((await world.read(supplierPath)).equals(local)).toBe(true);
    expect((await world.bash("test ! -e unapproved-read.xlsx")).code).toBe(0);
    expect(world.approvals().length - approvalsBefore).toBe(8);
    expect(world.approvals().slice(approvalsBefore)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "push", fileId: world.files.supplier, mode: "replace" }),
      expect.objectContaining({ action: "push", fileId: world.files.supplier, mode: "copy" }),
      expect.objectContaining({ action: "overwrite", fileId: world.files.supplier }),
    ]));
    world.setApproval(true);
  });

  await step("push replaces the Drive file in place as a new version", async () => {
    const local = await world.read(supplierPath);
    const pushed = await world.host("drive_push_file", { path: supplierPath });
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(pushed.body).toMatchObject({ ok: true, mode: "replace", file: { id: world.files.supplier, revision: "rev-2" }, previousRevision: "rev-1" });
    const drive = await driveFile(world.files.supplier);
    expect(drive.bytes.equals(local)).toBe(true);
    expect((await world.host("drive_file_status", { path: supplierPath })).body).toMatchObject({ files: [{ local: "unchanged", drive: "unchanged", revision: "rev-2" }] });
    expect((await world.host("drive_push_file", { path: supplierPath })).body).toMatchObject({ ok: true, unchanged: true });
    expect((await driveFile(world.files.supplier)).revision).toBe("rev-2");
  });

  await step("edits made while confirmation is open stop the save before any Drive upload", async () => {
    const before = await driveFile(world.files.supplier);
    const uploads = await world.uploadRequests();
    expect(uploads).toBeGreaterThan(0);
    expect((await world.bash(`printf ' pending edit' >> '${supplierPath}'`)).code).toBe(0);
    const local = await world.read(supplierPath);
    world.editDuringApproval(supplierPath);
    const refused = await world.host("drive_push_file", { path: supplierPath });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "local_changes" });
    const changed = await world.read(supplierPath);
    expect(changed.length).toBeGreaterThan(local.length);
    expect(changed.subarray(local.length).toString()).toBe("edited while confirmation was open");
    expect(await world.uploadRequests()).toBe(uploads);
    const after = await driveFile(world.files.supplier);
    expect([after.revision, after.bytes.equals(before.bytes)]).toEqual([before.revision, true]);
  });

  await step("a Drive edit made after the pull is never overwritten silently", async () => {
    const theirs = Buffer.from("a collaborator's newer workbook");
    await world.google.editDriveFile(world.accounts.member, world.files.supplier, theirs);
    expect((await world.bash(`printf 'row 13: Beta Parts' | dd of='${supplierPath}' bs=1 seek=8192 conv=notrunc 2>/dev/null`)).code).toBe(0);
    expect((await world.host("drive_file_status", { path: supplierPath })).body).toMatchObject({ files: [{ local: "edited", drive: "changed", currentRevision: "rev-3" }] });
    const refused = await world.host("drive_push_file", { path: supplierPath });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "drive_conflict" });
    expect((await driveFile(world.files.supplier)).bytes.equals(theirs)).toBe(true);
    const local = await world.read(supplierPath);
    const copy = await world.host("drive_push_file", { path: supplierPath, mode: "copy" });
    expect(copy.status, JSON.stringify(copy.body)).toBe(200);
    expect(copy.body).toMatchObject({ ok: true, mode: "copy", copiedFrom: world.files.supplier, file: { name: "Supplier entry (edited).xlsx", mimeType: XLSX } });
    const saved = await driveFile(String((copy.body.file as Record<string, unknown>).id));
    expect(saved.parents).toEqual(["suppliers-folder"]);
    expect(saved.bytes.equals(local)).toBe(true);
    expect((await driveFile(world.files.supplier)).bytes.equals(theirs)).toBe(true);
  });

  await step("a Google Sheet opened through a Drive shortcut comes down as xlsx and goes back as a new Google Sheet", async () => {
    const sheetPath = "drive/Inventory (2).xlsx";
    expect((await world.bash("printf 'my own notes' > drive/Inventory.xlsx")).code).toBe(0);
    const pulled = await world.host("drive_pull_file", { fileId: world.files.inventoryShortcut, connectionId: world.fullId });
    expect(pulled.body).toMatchObject({ ok: true, path: sheetPath, exportedAs: "xlsx", file: { id: world.files.inventory, mimeType: SHEET } });
    expect((await world.read(sheetPath)).equals(inventoryExport)).toBe(true);
    expect((await world.read("drive/Inventory.xlsx")).toString()).toBe("my own notes");
    expect((await world.bash(`printf ' widget,18' >> '${sheetPath}'`)).code).toBe(0);
    const repull = await world.host("drive_pull_file", { fileId: world.files.inventory, connectionId: world.fullId });
    expect(repull.status).toBe(409);
    expect(repull.body).toMatchObject({ code: "local_changes" });
    const replaced = await world.host("drive_push_file", { path: sheetPath, mode: "replace" });
    expect(replaced.status).toBe(400);
    expect(replaced.body).toMatchObject({ code: "native_file_replace_unsupported" });
    const local = await world.read(sheetPath);
    const saved = await world.host("drive_push_file", { path: sheetPath });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ ok: true, mode: "copy", file: { name: "Inventory (edited)", mimeType: SHEET } });
    const copy = await driveFile(String((saved.body.file as Record<string, unknown>).id));
    expect(copy.parents).toEqual(["inventory-folder"]);
    expect(Buffer.from(copy.exports[XLSX] ?? "", "base64").equals(local)).toBe(true);
    expect((await driveFile(world.files.inventory)).version).toBe("1");
  });

  await step("confirmation shows the real Drive target even when a local link label is changed", async () => {
    const original = await driveFile(world.files.supplier);
    const uploads = await world.uploadRequests();
    expect((await world.bash(`printf ' unsaved edit' >> '${supplierPath}'`)).code).toBe(0);
    const record = await world.rewriteLink(supplierPath, { fileId: world.files.supplier, name: "misleading local label", revision: original.revision });
    world.setApproval(false);
    try {
      const refused = await world.host("drive_push_file", { path: supplierPath });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: "drive_write_denied" });
      expect(world.approvals().at(-1)).toMatchObject({ action: "push", fileId: world.files.supplier, name: original.name, webViewLink: expect.stringContaining(world.files.supplier) });
      expect(world.approvals().at(-1)?.name).not.toBe("misleading local label");
      expect(await world.uploadRequests()).toBe(uploads);
      expect((await driveFile(world.files.supplier)).bytes.equals(original.bytes)).toBe(true);
    } finally {
      world.setApproval(true);
      await record.restore();
    }
  });

  await step("after: another member, a read-only connection and paths or symlinks outside the workspace are refused", async () => {
    const other = await world.describeAs("second", world.files.supplier);
    expect(other.status).toBe(502);
    expect(String(other.body.message)).toContain("may not have access");
    const pulled = await world.host("drive_pull_file", { fileId: world.files.supplier, connectionId: world.readOnlyId, path: "read-only/Supplier.xlsx" });
    expect(pulled.status, JSON.stringify(pulled.body)).toBe(200);
    expect((await world.bash("printf 'blocked' >> read-only/Supplier.xlsx")).code).toBe(0);
    const before = await driveFile(world.files.supplier);
    const denied = await world.host("drive_push_file", { path: "read-only/Supplier.xlsx" });
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ code: "needs_connection" });
    const after = await driveFile(world.files.supplier);
    expect([after.revision, after.bytes.equals(before.bytes)]).toEqual([before.revision, true]);
    const escaped = await world.host("drive_pull_file", { fileId: world.files.supplier, connectionId: world.fullId, path: "../outside.xlsx" });
    expect(escaped.status).toBe(403);
    expect(escaped.body).toMatchObject({ code: "path_outside_workspace" });
    expect((await world.bash("mkdir -p ../outside && ln -s ../outside linked")).code).toBe(0);
    const linked = await world.host("drive_pull_file", { fileId: world.files.supplier, connectionId: world.fullId, path: "linked/Supplier.xlsx" });
    expect(linked.status).toBe(403);
    expect(linked.body).toMatchObject({ code: "path_outside_workspace" });
    expect((await world.bash("ls -A ../outside | wc -l")).stdout.trim()).toBe("0");
  });
});
