import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { driveUploads } from "../worlds/drive-uploads.ts";

// Browser-less: an external MCP client authorizes and transports its own local file through the real gateway.
const test = spec.world(driveUploads, { resources: { surfaces: [], services: ["den"] }, needs: { commands: ["bun", "pnpm"], placement: "local" }, timeout: 600_000 });
test("a member uploads a large file to the selected Drive account without exposing file bytes to Den", async ({ world, step, evidence }) => {
  const capability = `native:${world.selectedId}:createGoogleDriveUploadSession`;
  const bytes = new Uint8Array(9 * 1024 * 1024 + 17).fill(137);
  const body = { name: "large-video.mp4", size: bytes.byteLength, mimeType: "video/mp4", folderId: "selected-folder" };
  const smallForm = (connectionId = world.selectedId) => {
    const form = new FormData(); form.append("connectionId", connectionId); form.append("folderId", "selected-folder");
    form.append("file", new File([new Uint8Array([1, 2, 3, 251])], "small.bin", { type: "application/octet-stream" })); return form;
  };
  await step("before: a small upload goes to the selected account", async () => {
    expect((await world.host("drive-files", smallForm())).status).toBe(200);
    const selected = await world.google.driveUploadsFor(world.mailboxes.selected, { timeoutMs: 5_000 });
    expect(selected).toHaveLength(1); expect(selected[0].content).toEqual(Buffer.from([1, 2, 3, 251]));
    expect(await world.google.driveUploadsFor(world.mailboxes.other, { timeoutMs: 5_000 })).toEqual([]);
    evidence.recordAssertionEvidence("Small uploads use the selected account", "Selected mailbox received the 4 exact bytes; default mailbox stayed empty.", true);
  });
  await step("the member discovers upload preparation and sends the large file directly to Google", async () => {
    const search = await world.mcp("search_capabilities", { query: "Drive Selected resumable upload", limit: 20 });
    expect(world.objects(search).some((entry) => entry.name === capability)).toBe(true);
    const result = await world.mcp("execute_capability", { name: capability, body });
    expect(result.isError).toBe(false);
    const session = world.objects(result).find((entry) => entry.ok === true && typeof entry.uploadUrl === "string");
    if (!session || typeof session.uploadUrl !== "string") throw new Error("No upload session returned");
    expect(session.size).toBe(bytes.byteLength);
    expect(session.instructions).toContain("bearer credential");
    const chunk = 8 * 1024 * 1024;
    const first = await world.put(session.uploadUrl, bytes.slice(0, chunk), `bytes 0-${chunk - 1}/${bytes.byteLength}`);
    expect(first.status).toBe(308); expect(first.headers.get("range")).toBe(`bytes=0-${chunk - 1}`); await first.body?.cancel();
    const final = await world.put(session.uploadUrl, bytes.slice(chunk), `bytes ${chunk}-${bytes.byteLength - 1}/${bytes.byteLength}`);
    expect(final.status).toBe(200); const file = await final.json(); expect(file.id).toBeTruthy();
    const uploads = await world.google.driveUploadsFor(world.mailboxes.selected, { timeoutMs: 5_000 });
    expect(uploads).toHaveLength(2);
    // Native byte equality avoids walking millions of entries while the in-process HTTP witness is paused.
    expect(uploads[1].content.equals(Buffer.from(bytes))).toBe(true);
    expect(await world.google.driveUploadsFor(world.mailboxes.other, { timeoutMs: 5_000 })).toEqual([]);
    expect(await world.google.driveUploadsFor(world.mailboxes.second, { timeoutMs: 5_000 })).toEqual([]);
    evidence.recordAssertionEvidence("A 9 MiB+17-byte file completes in the selected account", "Real gateway returned a metadata-only session. Google acknowledged an 8 MiB chunk with 308, then returned a completed file id; the selected mailbox held the exact bytes and both other mailboxes stayed empty. No bearer URL is included in evidence.", true);
  });
  await step("another member, an unconnected selection and a read-only account cannot start uploads", async () => {
    const before = (await world.requests()).length;
    const selections: Array<[string, "first" | "second"]> = [[world.selectedId, "second"], [world.unavailableId, "first"], [world.readOnlyId, "first"]];
    for (const [connectionId, identity] of selections) {
      const result = await world.host("drive-upload-sessions", JSON.stringify({ ...body, connectionId }), identity, true);
      expect(result.status).toBe(409);
    }
    expect((await world.host("drive-upload-sessions", JSON.stringify(body), "missing", true)).status).toBe(401);
    expect((await world.host("drive-files", smallForm(world.unavailableId))).status).toBe(409);
    expect((await world.host("drive-files", smallForm(), "second")).status).toBe(409);
    expect((await world.host("drive-upload-sessions", JSON.stringify({ ...body, size: 0 }), "first", true)).status).toBe(400);
    expect((await world.requests()).length).toBe(before);
    evidence.recordAssertionEvidence("Unavailable selections and missing Drive write access fail closed", "Another member, an unconnected connection and read-only grants returned 409; missing auth returned 401 and invalid size 400. Both legacy selected-account negative probes also returned 409. Google received zero additional requests; no default-account fallback occurred.", true);
  });
  await step("after: a session prepared by the host completes, and small uploads still work", async () => {
    const result = await world.host("drive-upload-sessions", JSON.stringify({ name: "last.bin", size: 3, connectionId: world.selectedId }), "first", true);
    expect(result.status).toBe(200);
    const session = world.objects(result.body).find((entry) => typeof entry.uploadUrl === "string");
    if (!session || typeof session.uploadUrl !== "string") throw new Error("No host session");
    const final = await world.put(session.uploadUrl, new Uint8Array([4, 5, 6]), "bytes 0-2/3"); expect(final.status).toBe(200); await final.body?.cancel();
    expect((await world.host("drive-files", smallForm())).status).toBe(200);
    evidence.recordAssertionEvidence("Host-prepared sessions and small uploads both complete", "A host-prepared Google session completed and selected-account legacy multipart still returned 200.", true);
  });
});
