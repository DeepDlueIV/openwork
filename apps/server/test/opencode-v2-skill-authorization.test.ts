import assert from "node:assert/strict";
import { test } from "node:test";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";

test("native attachment authorization is token-scoped, Cloud-only, and off with the existing rollout", async () => {
  let native = false;
  const evaluations: Array<{ sessionID: string; ids: string[] }> = [];
  const bridge = await createV2ContextBridge(async path => {
    assert.equal(path, "/experimental/connect/skills");
    return { skills: [{ name: "fixture-review", modelDiscovery: true }, { name: "hidden-review", modelDiscovery: false }],
      ...(native ? { delivery: "native" } : {}) };
  }, async (sessionID, ids) => {
    evaluations.push({ sessionID, ids });
    return { data: { id: "per_fixture", effect: "deny" } };
  });
  const sessionID = "ses_fixture";
  const ids = ["openwork-cloud-fixture-review"];
  const call = (input: unknown, token = bridge.token) => fetch(bridge.url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "openwork_skill_authorize", input }),
  });
  try {
    assert.equal((await call({ sessionID, ids }, "wrong-token")).status, 401);
    assert.equal((await call({ sessionID, ids })).status, 403);
    native = true;
    for (const input of [
      { sessionID: "../session", ids }, { sessionID, ids: ["local-skill"] },
      { sessionID, ids: [] }, { sessionID, ids: Array.from({ length: 151 }, () => ids[0]) },
      { sessionID, ids, action: "shell" }, { sessionID, ids, decision: "always" },
    ]) assert.equal((await call(input)).status, 400);
    assert.equal((await call({ sessionID, ids: ["openwork-cloud-removed-review"] })).status, 403);
    assert.equal((await call({ sessionID, ids: ["openwork-cloud-hidden-review"] })).status, 403);
    assert.equal(evaluations.length, 0, "invalid, hidden and unlisted requests cannot evaluate permissions or grant approvals");
    const response = await call({ sessionID, ids });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { id: "per_fixture", effect: "deny" } });
    assert.deepEqual(evaluations, [{ sessionID, ids }]);
    native = false;
    assert.equal((await call({ sessionID, ids })).status, 403, "kill blocks new native authorization");
    assert.equal(evaluations.length, 1);
  } finally { await bridge.close(); }
});
