import { expect } from "vitest";
import { denFetch, mcpMock, needs, server, test } from "@openwork/testkit";

// When a provider refuses a tool call it says why in the tool result. The agent
// used to get only "the requested provider operation failed", so neither it nor
// the member could tell a plan limit from a bug.
const reason = "Usage limit exceeded: this workspace cannot create more items on its current plan.";

test("a connector action the provider refuses tells the agent the provider's reason", { timeout: 180_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun"] });
  await using den = await server({
    place, web: false,
    mocks: {
      tracker: mcpMock({
        allowUnauthenticatedMcp: true,
        tools: [{
          name: "create_item",
          description: "Create an item",
          inputSchema: { type: "object", properties: { title: { type: "string" } } },
          result: { isError: true, content: [{ type: "text", text: reason }] },
        }],
      }),
    },
    org: { name: `Connector failure reason ${Date.now()}`, members: {} },
  });
  const headers = { authorization: `Bearer ${den.admin.token}` };
  const created = await denFetch(den.admin, "/v1/mcp-connections", {
    method: "POST", headers,
    body: JSON.stringify({ name: "Item tracker", url: den.mocks.tracker.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } }),
  });
  expect(created.response.status, created.text).toBe(200);
  if (!isRecord(created.body) || typeof created.body.id !== "string") throw new Error("Connection id missing");
  const connectionId = created.body.id;
  const minted = await denFetch(den.admin, "/v1/mcp/token", {
    method: "POST", headers, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  expect(minted.response.status, minted.text).toBe(200);
  if (!isRecord(minted.body) || typeof minted.body.token !== "string") throw new Error("Agent token missing");
  const sinceIso = new Date().toISOString();

  const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
    method: "POST",
    headers: { authorization: `Bearer ${minted.body.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "execute_capability", arguments: { name: `mcp:${connectionId}:create_item`, body: { title: "Quarterly review" } },
    } }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  expect(response.status, raw).toBe(200);
  const line = raw.split("\n").find((entry) => entry.startsWith("data:"));
  const rpc: unknown = JSON.parse(line ? line.slice(5) : raw);
  const result = isRecord(rpc) && isRecord(rpc.result) ? rpc.result : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const first: unknown = content[0];
  const payload: unknown = isRecord(first) && typeof first.text === "string" ? JSON.parse(first.text) : null;
  if (!isRecord(payload)) throw new Error(`Agent result missing: ${raw.slice(0, 500)}`);

  const calls = await den.mocks.tracker.toolCalls({ name: "create_item", sinceIso, atLeast: 1 });
  evidence.recordAssertionEvidence(
    "given a provider that refuses the action and says why",
    `The provider received ${calls.length} create_item call(s) with title ${JSON.stringify(calls[0]?.args.title)}.`,
    calls.length === 1 && calls[0]?.args.title === "Quarterly review",
  );
  expect(calls).toMatchObject([{ name: "create_item", args: { title: "Quarterly review" } }]);

  evidence.recordAssertionEvidence(
    "the agent is told the action failed, not that it succeeded",
    `execute_capability returned isError=${String(result.isError)}, error=${String(payload.error)}, retryable=${String(payload.retryable)}.`,
    result.isError === true && payload.error === "provider_error" && payload.retryable === false,
  );
  expect(result.isError).toBe(true);
  expect(payload).toMatchObject({ error: "provider_error", retryable: false });

  const providerError = isRecord(payload.providerError) ? payload.providerError : {};
  evidence.recordAssertionEvidence(
    "after: the agent sees the provider's own reason",
    `providerError.message is ${JSON.stringify(providerError.message ?? null)}.`,
    providerError.message === reason,
  );
  expect(providerError.message).toBe(reason);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
