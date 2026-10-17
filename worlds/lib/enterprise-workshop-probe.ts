// Explicit paid rehearsal; never runs automatically while starting a world.
// node worlds/lib/enterprise-workshop-probe.ts <private-world-receipt.json>
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { record } from "./acme-gateway.ts";
import { assertAcmeMcpOrigins } from "./acme-runtime.ts";
import { verifyWorkshop } from "./workshop-verification.mjs";

const receipt = JSON.parse(await readFile(process.argv[2], "utf8"));
const out = receipt.outputs;
for (const key of ["openworkUrl", "denApi", "atlassianState", "microsoftState"]) {
  const url = new URL(out[key]);
  assert.equal(url.hostname, "127.0.0.1", `Rehearsal requires owned loopback ${key}`);
  assert.equal(url.protocol, "http:");
  assert.equal(url.username + url.password + url.search + url.hash, "");
}
const headers = { authorization: `Bearer ${out.openworkToken}`, "content-type": "application/json" };
async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${out.openworkUrl}${path}`, { headers, redirect: "error", method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(360_000) });
  if (!response.ok) throw new Error(`Workshop probe ${path}: HTTP ${response.status}; private response omitted.`);
  return response.json();
}
const workspaces = await request("/workspaces");
const workspace = record(workspaces) && Array.isArray(workspaces.items) ? workspaces.items.find((item) => record(item) && item.id === out.workspaceId) : undefined;
assert.ok(workspace && typeof workspace.path === "string");
const base = `/workspace/${out.workspaceId}`;
assertAcmeMcpOrigins(await request(`${base}/opencode/config`), out.denApi);
const session = await request(`${base}/opencode/session`, { title: "Connected Acme workday verification" });
assert.ok(record(session) && typeof session.id === "string");
console.log(`Created rehearsal session ${session.id}; starting paid default-agent turn.`);
const marker = `Workshop-comparison-${Date.now()}`;
const beforeMail = await fetch(out.microsoftState).then((r) => r.json());
const existingDrafts = new Set(beforeMail.messages.map((mail: { id: string }) => mail.id));
let result: unknown;
try {
result = await request(`${base}/opencode/session/${session.id}/message`, {
  model: { providerID: out.providerId, modelID: out.modelId },
  parts: [{ type: "text", text: `This is an authorized fictional Acme Robotics rehearsal. Read the brief at the absolute workspace path ${JSON.stringify(`${workspace.path}/WORKSHOP.md`)} first (not /WORKSHOP.md). Use connected service tools, not local substitutes. Discover the Confluence content search tool (capability discovery searches tool metadata, not documents), then search the PROD product space for the Atlas 2 and Atlas Lift datasheets and read both complete pages. Do not guess page IDs or use Jira's DOC key as a Confluence space. Create a Jira Task in DOC titled "${marker}" assigned to Nora Patel, with a short factual product comparison in its description. Create a OneDrive text document named "${marker}.txt" with that comparison. Read the most recent Inbox message in Outlook (the latest update in the customer-review thread) and use the threaded reply-draft operation to create a reply DRAFT in that same conversation that links the OneDrive document; do not send. You have explicit approval for these three mock writes. Verify all three using connected reads. If blocked, stop and say why. Do not use external real services. Report the issue key, draft ID, and document ID.` }],
});
} catch (error) {
  await request(`${base}/opencode/session/${session.id}/abort`, {}).catch(() => undefined);
  throw error;
}
if (record(result) && record(result.info) && result.info.error) throw new Error("Default-agent inference returned an error; inspect private runtime logs.");
const messages = await request(`${base}/opencode/session/${session.id}/message`);
const atlassian = await fetch(out.atlassianState).then((r) => r.json());
const microsoft = await fetch(out.microsoftState).then((r) => r.json());
const { issue, document, draft } = verifyWorkshop({ messages, atlassian, microsoft, marker, providerId: out.providerId, modelId: out.modelId });
assert.equal(microsoft.messages.filter((mail: { parentFolderId: string }) => mail.parentFolderId === "sentitems").length, beforeMail.messages.filter((mail: { parentFolderId: string }) => mail.parentFolderId === "sentitems").length, "Rehearsal must not send mail");
assert.ok(microsoft.messages.some((mail: { id: string; isDraft: boolean; body: unknown }) => !existingDrafts.has(mail.id) && mail.isDraft && (JSON.stringify(mail.body).includes(document.webUrl) || JSON.stringify(mail.body).includes(document.id))), "No new Outlook reply draft linking the OneDrive document in backend");
console.log(JSON.stringify({ verdict: "Passed", sessionId: session.id, marker, issueKey: issue.key, draftId: draft.id, documentId: document.id, checks: ["default agent", "Confluence tool trace", "Jira backend", "OneDrive backend", "Outlook draft backend"] }, null, 2));
