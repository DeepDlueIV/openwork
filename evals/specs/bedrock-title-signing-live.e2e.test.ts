import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { bedrockTitleDesktop } from "../worlds/bedrock-title-desktop.ts";

const test = spec.world(bedrockTitleDesktop, {
  resources: { surfaces: ["desktop"], services: [], nativeReason: "Explicit fixed-build Electron verification of AWS credentials passed to the bundled engine." },
  needs: { platform: "darwin", env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] }, timeout: 600_000,
});

test("an isolated fixed Electron build signs a real Bedrock session-title request correctly", { timeout: 600_000 }, async ({ world, user, agent, probe, evidence }) => {
  const person = user.on(world.app);
  await person.reload();
  await person.see({ role: "button", label: "Change model" }, { text: /Amazon Nova Micro/, timeoutMs: 60_000 });
  const config = await agent.on(world.app).desktopApi(`/workspace/${world.workspace.workspaceId}/opencode/config`, { method: "GET" });
  expect(config.status).toBe(200);
  expect(JSON.stringify(config.body)).toContain("observer.ts");
  await person.type("composer", "Tell me one thing about a kite in a meadow.", { verify: true });
  await person.click({ role: "button", label: "Run task" });
  await eventually(async () => {
    const state = await probe.on(world.app).composer();
    return state.userMessageCount;
  }, { within: 15_000, until: (count) => count > 0 });
  const receipts = await eventually(world.receipts, {
    within: 120_000, until: (values) => values.some((value) => value.title === true) && values.some((value) => value.outcome === "rate_or_quota_limited"),
  });
  const titles = receipts.filter((receipt) => receipt.title === true);
  expect(titles.length).toBeGreaterThan(0);
  for (const title of titles) {
    expect(title.status).toBe(429);
    expect(title.signatureError).toBe(false);
    expect(title.headerNames).toContain("x-openwork-title-attempt");
  }
  expect(receipts.some((receipt) => receipt.outcome === "signature_rejected")).toBe(false);
  const safe = JSON.stringify(receipts);
  for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
    const value = process.env[key];
    if (!value) throw new Error("Missing live credentials");
    expect(safe).not.toContain(value);
  }
  evidence.recordAssertionEvidence("Fixed Electron built-in Bedrock signature accepted by AWS", safe, true);
});
