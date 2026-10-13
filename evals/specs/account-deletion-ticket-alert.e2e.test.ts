import { createServer, type IncomingMessage } from "node:http";
import { gunzipSync } from "node:zlib";
import { expect } from "vitest";
import { denFetch, eventually, needs, server, test } from "@openwork/testkit";

// Each account deletion opens a compliance issue in Linear. When Linear refused
// it, Den logged a warning and carried on, so deletions went unrecorded for days
// before anyone noticed. A refusal must reach error tracking.
const refusal = "usage limit exceeded";

test("an account deletion whose compliance issue Linear refuses is reported to error tracking", { timeout: 180_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun"] });
  const linearRequests: string[] = [];
  await using linear = await listen(async (request, body) => {
    linearRequests.push(body);
    return { status: 200, body: JSON.stringify({ errors: [{ message: refusal }] }) };
  });
  const sentryEvents: string[] = [];
  await using sentry = await listen(async (request, body) => {
    // An envelope is newline-delimited JSON: a header, then item header and payload pairs.
    const lines = body.split("\n").filter(Boolean);
    for (let index = 1; index + 1 < lines.length; index += 2) {
      const item = JSON.parse(lines[index] ?? "{}") as { type?: string };
      if (item.type === "event") sentryEvents.push(lines[index + 1] ?? "");
    }
    return { status: 200, body: "{}" };
  });
  const organizationName = `Deletion ticket alert ${Date.now()}`;
  await using den = await server({
    place, web: false, org: { name: organizationName, members: {} },
    env: {
      LINEAR_API_KEY: "synthetic-linear-key",
      LINEAR_COMPLIANCE_TEAM_ID: "synthetic-compliance-team",
      LINEAR_API_BASE: `${linear.url}/graphql`,
      DEN_OBSERVABILITY_BACKEND: "sentry",
      SENTRY_DSN: `http://public@127.0.0.1:${sentry.port}/1`,
      SENTRY_ENVIRONMENT: "evals",
    },
  });

  const deleted = await denFetch(den.admin, "/v1/org", {
    method: "DELETE", headers: { authorization: `Bearer ${den.admin.token}` }, body: JSON.stringify({ confirmation: organizationName }),
  });
  expect(deleted.response.status, deleted.text).toBe(200);
  evidence.recordAssertionEvidence(
    "given Linear refuses the compliance issue, the deletion still completes",
    `DELETE /v1/org answered ${deleted.response.status}; Linear received ${linearRequests.length} request(s), the first creating ${JSON.stringify(linearRequests[0]?.match(/\[ACCOUNT DELETION\][^"\\]*/)?.[0] ?? null)}.`,
    deleted.response.status === 200 && linearRequests.length === 1 && linearRequests[0]?.includes("[ACCOUNT DELETION]") === true,
  );
  expect(linearRequests).toHaveLength(1);
  expect(linearRequests[0]).toContain("[ACCOUNT DELETION]");

  const log = await den.apiLog();
  const failureLine = log.split(/\r?\n/).find((line) => line.includes("failed to create Linear issue")) ?? "";
  evidence.recordAssertionEvidence(
    "Den logs the refusal at error level with Linear's reason",
    `Log line: ${failureLine.slice(0, 240) || "none"}`,
    failureLine.includes('"level":"error"') && failureLine.includes(refusal),
  );
  expect(failureLine).toContain('"level":"error"');
  expect(failureLine).toContain(refusal);

  const reported = await eventually(() => Promise.resolve(sentryEvents.filter((event) => event.includes(refusal))), {
    within: 20_000, intervalMs: 250, until: (events) => events.length > 0, label: "refusal reported to error tracking",
  }).catch(() => []);
  evidence.recordAssertionEvidence(
    "after: error tracking receives the refusal",
    `Error tracking received ${sentryEvents.length} event(s), ${reported.length} naming "${refusal}".`,
    reported.length === 1,
  );
  expect(reported).toHaveLength(1);
});

async function listen(handle: (request: IncomingMessage, body: string) => Promise<{ status: number; body: string }>) {
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const body = (request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString();
    const reply = await handle(request, body);
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(reply.body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing local server address");
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    [Symbol.asyncDispose]: () => new Promise<void>((resolve, reject) => {
      http.closeAllConnections();
      http.close((error) => error ? reject(error) : resolve());
    }),
  };
}
