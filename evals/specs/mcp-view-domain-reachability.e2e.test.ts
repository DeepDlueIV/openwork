import { expect } from "vitest";
import { SkipError, spec } from "@openwork/testkit";

// A configured web/marketing URL used to make GET / redirect off the MCP
// origin. Check the real HTTP boundary without following that redirect.
const test = spec.world(async (seed) => {
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) {
    throw new SkipError("a fresh Den boot to apply the marketing URL fixture; unset OPENWORK_EVAL_DEN_API_URL");
  }
  const den = await seed.den({
    web: false,
    provision: false,
    env: { DEN_MARKETING_URL: "https://marketing.example.test" },
  });
  return { apiUrl: den.ref.apiUrl };
}, { resources: { surfaces: [], services: ["den"] }, timeout: 300_000 });

test("an MCP host can verify the API origin without signing in or leaving the domain", async ({ world, step, evidence }) => {
  const request = (path: string, method = "GET") => fetch(`${world.apiUrl}${path}`, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });

  await step("after: an anonymous domain probe receives a direct success even with a marketing URL configured", async () => {
    const response = await request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");
    const body: unknown = await response.json();
    expect(body).toMatchObject({ ok: true, service: "den-api", version: expect.any(String) });
    evidence.recordAssertionEvidence(
      "The API origin responds directly instead of redirecting to the configured marketing site",
      `Anonymous GET / returned ${response.status}, no Location header, and ${JSON.stringify(body)}; redirects were disabled.`,
      true,
    );
  });

  await step("a headers-only domain probe also succeeds without a redirect", async () => {
    const response = await request("/", "HEAD");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toBe("");
    evidence.recordAssertionEvidence(
      "HEAD probes can verify the same domain",
      `Anonymous HEAD / returned ${response.status}, no Location header, and no response body.`,
      true,
    );
  });

  await step("the reachable origin does not grant anonymous access to the MCP server", async () => {
    const response = await request("/mcp/agent");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(response.headers.get("location")).toBeNull();
    await response.arrayBuffer();
    evidence.recordAssertionEvidence(
      "MCP authentication stays required",
      `Anonymous GET /mcp/agent returned ${response.status} with a Bearer challenge, not tool access or a redirect.`,
      true,
    );
  });
});
