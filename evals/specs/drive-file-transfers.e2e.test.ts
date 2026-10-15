import { createHash } from "node:crypto";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { driveFileTransfers, inventoryExport, SHEET, supplierWorkbook, XLSX } from "../worlds/drive-file-transfers.ts";

const CHUNK = 8 * 1024 * 1024;
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");

// Browser-less: a member's host transport moves Drive bytes through the real Den; only Google is synthetic.
const test = spec.world(driveFileTransfers, { resources: { surfaces: [], services: ["den"] }, needs: { commands: ["bun", "pnpm"], placement: "local" }, timeout: 600_000 });
test("a host downloads a Drive file byte for byte and replaces it only from the revision it downloaded", async ({ world, step, evidence }) => {
  const files = "/v1/direct-downloads/google-workspace/drive-files";
  const sessions = "/v1/direct-uploads/google-workspace/drive-upload-sessions";
  const query = { connectionId: world.fullId };
  const driveFile = async (id: string) => {
    const file = (await world.google.driveFiles(world.accounts.member)).find((entry) => entry.id === id);
    if (!file) throw new Error(`Drive file ${id} missing`);
    return { ...file, bytes: Buffer.from(file.contentBase64, "base64") };
  };

  await step("before: the inline Drive read cannot return a 9 MiB Excel file", async () => {
    const result = await world.mcp("execute_capability", { name: `native:${world.fullId}:getCapabilitiesGoogleWorkspaceDriveFile`, path: { fileId: world.files.supplier } });
    const file = world.objects(result).find((entry) => entry.id === world.files.supplier && "contentUnavailableReason" in entry);
    expect(file).toMatchObject({ content: null, contentBase64: null, contentUnavailableReason: "file_too_large" });
    evidence.recordAssertionEvidence("The inline read returns no content for a large Excel file", "The Drive read capability answered file_too_large with null content for the 9 MiB + 17 byte workbook.", true);
  });

  await step("the host describes the file and downloads it in ranged chunks", async () => {
    const described = await world.host(`${files}/${world.files.supplier}`, { query });
    expect(described.status, described.bytes.toString()).toBe(200);
    expect(described.json).toMatchObject({ ok: true, file: { id: world.files.supplier, revision: "rev-1", md5Checksum: md5(supplierWorkbook), size: supplierWorkbook.byteLength }, download: { exported: false, size: supplierWorkbook.byteLength } });
    const parts: Buffer[] = [];
    for (let start = 0; start < supplierWorkbook.byteLength; start += CHUNK) {
      const end = Math.min(supplierWorkbook.byteLength, start + CHUNK) - 1;
      const part = await world.host(`${files}/${world.files.supplier}/content`, { query, headers: { range: `bytes=${start}-${end}` } });
      expect(part.status).toBe(206);
      expect(part.headers.get("content-range")).toBe(`bytes ${start}-${end}/${supplierWorkbook.byteLength}`);
      parts.push(part.bytes);
    }
    expect(parts).toHaveLength(2);
    expect(md5(Buffer.concat(parts))).toBe(md5(supplierWorkbook));
    expect((await world.host(`${files}/${world.files.supplier}/content`, { query, headers: { range: `bytes=0-${CHUNK}` } })).status).toBe(400);
    evidence.recordAssertionEvidence("Ranged downloads reassemble the exact file", "The pull plan reported revision rev-1, the md5 and the size without any content. Two ranged requests (8 MiB, then the rest) returned 206 with matching Content-Range and reassembled to the same md5; a range over 8 MiB was refused.", true);
  });

  await step("Google Sheets export as Office files and shortcuts open their target", async () => {
    const sheet = await world.host(`${files}/${world.files.inventoryShortcut}`, { query });
    expect(sheet.json).toMatchObject({ ok: true, file: { id: world.files.inventory, mimeType: SHEET, native: true }, download: { format: "xlsx", mimeType: XLSX, extension: ".xlsx", exported: true } });
    const exported = await world.host(`${files}/${world.files.inventory}/content`, { query: { ...query, format: "xlsx" } });
    expect(exported.status).toBe(200);
    expect(exported.bytes.equals(inventoryExport)).toBe(true);
    expect((await world.host(`${files}/${world.files.inventory}/content`, { query: { ...query, format: "xlsx" }, headers: { range: "bytes=0-9" } })).status).toBe(400);
    const csv = await world.host(`${files}/${world.files.inventory}/content`, { query: { ...query, format: "csv" } });
    expect(csv.bytes.toString()).toBe("sku,qty\nwidget,17\n");
    const folder = await world.host(`${files}/${world.files.folder}`, { query });
    expect(folder.status).toBe(400);
    evidence.recordAssertionEvidence("Google files download as Office or text exports", "A shortcut resolved to its Google Sheet, which exported whole as xlsx (exact bytes) or csv; ranges on exports and folders were refused.", true);
  });

  await step("a replace needs the downloaded revision and never overwrites newer Drive changes", async () => {
    const edited = Buffer.from(supplierWorkbook);
    edited.write("row 12: Acme Supplies", 4096);
    const body = { name: "Supplier entry.xlsx", size: edited.byteLength, mimeType: XLSX, fileId: world.files.supplier, connectionId: world.fullId };
    expect((await world.host(sessions, { method: "POST", body })).status).toBe(400);
    const theirs = Buffer.from("a collaborator's newer workbook");
    await world.google.editDriveFile(world.accounts.member, world.files.supplier, theirs);
    const stale = await world.host(sessions, { method: "POST", body: { ...body, baseRevision: "rev-1" } });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: "drive_conflict", currentRevision: "rev-2" });
    expect((await driveFile(world.files.supplier)).bytes.equals(theirs)).toBe(true);
    const prepared = await world.host(sessions, { method: "POST", body: { ...body, baseRevision: "rev-2" } });
    expect(prepared.status, prepared.bytes.toString()).toBe(200);
    expect(prepared.json).toMatchObject({ ok: true, replaces: { fileId: world.files.supplier, previousRevision: "rev-2" } });
    const uploadUrl = String(prepared.json?.uploadUrl);
    const first = await world.put(uploadUrl, edited.subarray(0, CHUNK), `bytes 0-${CHUNK - 1}/${edited.byteLength}`);
    expect(first.status).toBe(308); await first.body?.cancel();
    const final = await world.put(uploadUrl, edited.subarray(CHUNK), `bytes ${CHUNK}-${edited.byteLength - 1}/${edited.byteLength}`);
    expect(final.status).toBe(200);
    expect(await final.json()).toMatchObject({ id: world.files.supplier, headRevisionId: "rev-3", md5Checksum: md5(edited) });
    expect((await driveFile(world.files.supplier)).bytes.equals(edited)).toBe(true);
    evidence.recordAssertionEvidence("Replaces are tied to the downloaded revision", "Without baseRevision the session was refused. After a collaborator's change (rev-2), the stale revision returned drive_conflict and Drive kept their version. With rev-2 the session replaced the same file ID as rev-3 with the exact edited bytes.", true);
  });

  await step("Google files, read-only connections and other accounts cannot be replaced or read", async () => {
    const native = await world.host(sessions, { method: "POST", body: { name: "Inventory.xlsx", size: 10, mimeType: XLSX, fileId: world.files.inventory, baseRevision: "1", connectionId: world.fullId } });
    expect(native.status).toBe(400);
    expect(native.json).toMatchObject({ error: "native_file_replace_unsupported" });
    const readOnly = await world.host(sessions, { method: "POST", body: { name: "Supplier entry.xlsx", size: 10, mimeType: XLSX, fileId: world.files.supplier, baseRevision: "rev-3", connectionId: world.readOnlyId } });
    expect(readOnly.status).toBe(409);
    expect(readOnly.json).toMatchObject({ error: "needs_connection" });
    const other = await world.host(`${files}/${world.files.supplier}`, { query }, "second");
    expect(other.status).toBe(502);
    expect(String(other.json?.message)).toContain("may not have access");
    expect((await driveFile(world.files.supplier)).revision).toBe("rev-3");
    evidence.recordAssertionEvidence("Replaces stay inside the member's own write access", "A Google Sheet could not be replaced by an upload, a read-only connection got needs_connection, and another member's Google account got Google's no-access reason. The Drive file stayed at rev-3.", true);
  });

  await step("after: an edited export is saved as a new Google Sheet next to the original", async () => {
    const edited = Buffer.concat([inventoryExport, Buffer.from(" widget,18")]);
    const prepared = await world.host(sessions, { method: "POST", body: { name: "Inventory (edited)", size: edited.byteLength, mimeType: XLSX, convertTo: SHEET, folderId: "inventory-folder", connectionId: world.fullId } });
    expect(prepared.status, prepared.bytes.toString()).toBe(200);
    const final = await world.put(String(prepared.json?.uploadUrl), edited, `bytes 0-${edited.byteLength - 1}/${edited.byteLength}`);
    expect(final.status).toBe(200);
    const created = await final.json() as Record<string, unknown>;
    expect(created).toMatchObject({ name: "Inventory (edited)", mimeType: SHEET, parents: ["inventory-folder"] });
    const copy = await driveFile(String(created.id));
    expect(Buffer.from(copy.exports[XLSX] ?? "", "base64").equals(edited)).toBe(true);
    expect((await driveFile(world.files.inventory)).version).toBe("1");
    evidence.recordAssertionEvidence("Edited Google files come back as new Google files", "convertTo saved the edited workbook as a new Google Sheet in the original folder; the original Sheet stayed at version 1.", true);
  });
});
