import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { BEDROCK_REPLY, BEDROCK_TITLE, bedrockTitleSigning } from "../worlds/bedrock-title-signing.ts";
import { isRecord } from "../worlds/openwork-server-cli.ts";

const test = spec.world(bedrockTitleSigning, { resources: { surfaces: [], services: ["mock"] }, needs: { commands: ["bun"] }, timeout: 240_000 });

test("built-in Bedrock titles and chat reach a recomputing SigV4 endpoint with intact signatures", async ({ world, step, evidence }) => {
  await step("a normal Bedrock chat still succeeds without a title marker", async () => {
    const session = await world.engine("POST", "/session", {});
    if (!isRecord(session) || typeof session.id !== "string") throw new Error("Missing session id");
    const result = await world.engine("POST", `/session/${session.id}/message`, {
      model: { providerID: "amazon-bedrock", modelID: world.modelID },
      parts: [{ type: "text", text: "Tell me one thing about a kite in a meadow." }],
    });
    expect(isRecord(result) && isRecord(result.info) && result.info.error).toBeUndefined();
    expect(isRecord(result) && Array.isArray(result.parts) && result.parts.some((part) => isRecord(part) && part.text === BEDROCK_REPLY)).toBe(true);
    const chats = world.requests.filter((request) => !request.title);
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ signatureValid: true, markerPresent: false, markerSigned: false, status: 200 });
    await eventually(() => world.requests.some((request) => request.title), { within: 15_000 });
    // This assertion is RED when the plugin strips the signed title header.
    expect(world.requests.filter((request) => request.title)).toEqual([
      expect.objectContaining({ signatureValid: true, markerPresent: true, markerSigned: true, status: 200 }),
    ]);
    await eventually(() => world.engine("GET", `/session/${session.id}`), {
      within: 15_000, until: (value) => isRecord(value) && value.title === BEDROCK_TITLE,
    });
    await eventually(async () => (await world.diagnostics()).some((line) => line.includes("outcome=accepted")), { within: 10_000 });
    const diagnostics = (await world.diagnostics()).join("\n");
    expect(diagnostics).toContain("outcome=accepted");
    expect(diagnostics).not.toContain("signature_rejected");
    expect(diagnostics).not.toContain("dummy-bedrock");
    evidence.recordAssertionEvidence("Bedrock title and chat signatures validated independently", JSON.stringify(world.requests), true);
  });
});
