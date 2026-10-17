import assert from "node:assert/strict";
import test from "node:test";
import { assertAcmeMcpOrigins, acmeRuntimeFixture } from "./acme-runtime.ts";

const den = "http://127.0.0.1:40123";
const config = (url: string) => ({ mcp: { "openwork-cloud": { type: "remote", url, enabled: true } } });
test("seeded Acme MCP refuses hosted or foreign connections, including disabled ones", () => {
  assert.doesNotThrow(() => assertAcmeMcpOrigins(config(`${den}/mcp/agent`), den));
  for (const url of ["https://api.openworklabs.com/mcp/agent", "http://127.0.0.1:40124/mcp/agent", `${den}/other`, `${den}/mcp/agent?token=fixture`]) {
    assert.throws(() => assertAcmeMcpOrigins(config(url), den));
  }
  assert.throws(() => assertAcmeMcpOrigins({ mcp: { ...config(`${den}/mcp/agent`).mcp, stale: { type: "remote", url: "https://example.test/mcp", enabled: false } } }, den));
  assert.throws(() => assertAcmeMcpOrigins({ mcp: {} }, den));
});
test("seeded runtime workspace and credentials are outside the checkout and developer home", async () => {
  await using stack = new AsyncDisposableStack();
  const fixture = await acmeRuntimeFixture(stack);
  assert.equal(fixture.workspace.startsWith(process.cwd()), false);
  assert.notEqual(fixture.env.HOME, process.env.HOME);
  assert.equal(fixture.env.OPENAI_API_KEY, undefined);
  assert.equal(fixture.env.OPENCODE_CONFIG, undefined);
  assert.equal(fixture.env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(fixture.env.OPENWORK_TOKEN, undefined);
  assert.ok(fixture.env.OPENCODE_CONFIG_DIR?.includes("config/opencode"));
});
