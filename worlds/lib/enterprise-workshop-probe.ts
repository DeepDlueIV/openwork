// Explicit paid rehearsal; never runs automatically while starting a world.
// node worlds/lib/enterprise-workshop-probe.ts <private-world-receipt.json>
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { record } from "./acme-gateway.ts";
import { assertAcmeMcpOrigins } from "./acme-runtime.ts";

const receipt = JSON.parse(await readFile(process.argv[2], "utf8"));
const out = receipt.outputs;
for (const key of ["openworkUrl", "atlassianState", "microsoftState"]) {
  const url = new URL(out[key]);
  assert.equal(url.hostname, "127.0.0.1", `Rehearsal requires owned loopback ${key}`);
}
const headers = { authorization: `Bearer ${out.openworkToken}`, "content-type": "application/json" };
async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${out.openworkUrl}${path}`, { headers, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(360_000) });
  if (!response.ok) throw new Error(`Workshop probe ${path}: HTTP ${response.status}; private response omitted.`);
  return response.json();
}
const base = `/workspace/${out.workspaceId}`;
assertAcmeMcpOrigins(await request(`${base}/opencode/config`), out.denApi);
const session = await request(`${base}/opencode/session`, { title: "Connected Acme workday verification" });
assert.ok(record(session) && typeof session.id === "string");
console.log(`Created rehearsal session ${session.id}; starting paid default-agent turn.`);
const marker = `Workshop-comparison-${Date.now()}`;
const beforeMail = await fetch(out.microsoftState).then((r) => r.json());
const existingDrafts = new Set(beforeMail.messages.map((mail: { id: string }) => mail.id));
const result = await request(`${base}/opencode/session/${session.id}/message`, {
  model: { providerID: out.providerId, modelID: out.modelId },
  parts: [{ type: "text", text: `This is an authorized fictional Acme Robotics rehearsal. Read WORKSHOP.md first. Use connected service tools, not local substitutes. Discover the Confluence content search tool (capability discovery searches tool metadata, not documents), then search the PROD product space for the Atlas 2 and Atlas Lift datasheets and read both complete pages. Do not guess page IDs or use Jira's DOC key as a Confluence space. Create a Jira Task in DOC titled "${marker}" assigned to Nora Patel, with a short factual product comparison in its description. Create a OneDrive text document named "${marker}.txt" with that comparison. Read the latest customer request in Outlook and create a reply DRAFT that links the OneDrive document; do not send. You have explicit approval for these three mock writes. Verify all three using connected reads. If blocked, stop and say why. Do not use external real services. Report the issue key, draft ID, and document ID.` }],
});
if (record(result) && record(result.info) && result.info.error) throw new Error("Default-agent inference returned an error; inspect private runtime logs.");
const messages = await request(`${base}/opencode/session/${session.id}/message`);
const toolParts = Array.isArray(messages) ? messages.flatMap((message) => record(message) && Array.isArray(message.parts) ? message.parts.filter((part) => record(part) && part.type === "tool") : []) : [];
assert.ok(toolParts.some((part) => record(part.state) && part.state.status === "completed" && /confluence/i.test(JSON.stringify(part)) && /Atlas/.test(JSON.stringify(part.state.output))), "No completed Confluence product read in the tool trace");
const atlassian = await fetch(out.atlassianState).then((r) => r.json());
const microsoft = await fetch(out.microsoftState).then((r) => r.json());
const issue = atlassian.jira.issues.find((item: { fields?: { summary?: string }; summary?: string }) => item.fields?.summary === marker || item.summary === marker);
assert.ok(issue, "No matching Jira ticket in mock backend");
assert.ok(JSON.stringify(issue).includes("Nora") || JSON.stringify(issue).includes("nora"), "Ticket was not assigned to Nora");
const document = microsoft.files.find((file: { name: string }) => file.name === `${marker}.txt`);
assert.ok(document, "No OneDrive document in backend");
assert.ok(microsoft.messages.some((mail: { id: string; isDraft: boolean; body: unknown }) => !existingDrafts.has(mail.id) && mail.isDraft && (JSON.stringify(mail.body).includes(document.webUrl) || JSON.stringify(mail.body).includes(document.id))), "No new Outlook reply draft linking the OneDrive document in backend");
console.log(JSON.stringify({ verdict: "Passed", sessionId: session.id, marker, issueKey: issue.key, checks: ["default agent", "Confluence tool trace", "Jira backend", "OneDrive backend", "Outlook draft backend"] }, null, 2));
