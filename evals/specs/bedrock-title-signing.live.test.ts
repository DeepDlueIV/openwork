import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { liveBedrockTitle } from "../worlds/bedrock-title-live.ts";
import { isRecord } from "../worlds/openwork-server-cli.ts";

const test = spec.world(liveBedrockTitle, {
  resources: { surfaces: [], services: [] },
  needs: { env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "OPENWORK_BEDROCK_COLUMN"] }, timeout: 240_000,
});

test("real Bedrock checks session-title signatures with OpenWork plugins loaded", async ({ world, evidence }) => {
  const session = await world.engine("POST", "/session", {});
  if (!isRecord(session) || typeof session.id !== "string") throw new Error("Missing session id");
  await world.engine("POST", `/session/${session.id}/message`, {
    model: { providerID: "amazon-bedrock", modelID: world.modelID },
    parts: [{ type: "text", text: "Tell me one thing about a kite in a meadow." }],
  });
  await eventually(() => world.diagnostics.some((line) => /outcome=(access_rejected|rate_or_quota_limited|model_or_endpoint_missing|accepted|signature_rejected)/.test(line)), { within: 90_000 });
  const titles = world.receipts.filter((receipt) => receipt.title);
  expect(titles.length).toBeGreaterThan(0);
  if (world.column === "C") {
    expect(titles.every((receipt) => !receipt.signatureError)).toBe(true);
    expect(titles.every((receipt) => [200, 403, 404, 429].includes(receipt.status))).toBe(true);
    expect(titles.every((receipt) => receipt.headerNames.includes("x-openwork-title-attempt"))).toBe(true);
  } else {
    expect(titles.every((receipt) => receipt.signatureError && receipt.status === 403)).toBe(true);
    expect(titles.every((receipt) => !receipt.headerNames.includes("x-openwork-title-attempt"))).toBe(true);
  }
  const safe = JSON.stringify({ column: world.column, requests: world.receipts, diagnostics: world.diagnostics });
  for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
    const value = process.env[key];
    if (!value) throw new Error("Missing live credentials");
    expect(safe).not.toContain(value);
  }
  console.log("SANITIZED_BEDROCK_EVIDENCE", safe);
  evidence.recordAssertionEvidence(`Real Bedrock column ${world.column}: signature-level result`, safe, true);
});
