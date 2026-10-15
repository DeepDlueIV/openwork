import { expect } from "vitest";
import { readTranscriptMessages, spec } from "@openwork/testkit";
import { chatStreamReconnectWeb, streamedContinuityBullets, streamedContinuityPrompt } from "../worlds/v2-chat-reconnect.ts";

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const normalizedLines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");

const reconnectTest = spec.world(chatStreamReconnectWeb, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

reconnectTest("RECONNECT-01 a member sees tools finish and an answer keep growing after reconnecting", async ({ world, user, probe, step }) => {
  const stop = { role: "button", label: "Stop" } as const;
  const reconnect = async () => {
    const before = await world.engineHttpEvents();
    await world.continuity.reconnectEvents();
    const after = await probe.eventually(() => world.engineHttpEvents(), {
      within: 15_000, intervalMs: 100, label: "a new event connection after the network interruption",
      until: (value) => value.streams > before.streams,
    });
    expect(after.streams).toBeGreaterThan(before.streams);
    return { before: before.streams, after: after.streams };
  };
  await step("before: a member sees a command running on the original connection", async () => {
    await user.type("composer", streamedContinuityPrompt);
    await user.click("Run task");
    await user.see({ text: /sleep 15/ }, { timeoutMs: 60_000 });
    await user.see(stop);
    await user.screenshot();
  });
  await step("after: the command finishes on a new connection while the answer is still running", async () => {
    const connections = await reconnect();
    await user.see({ text: streamedContinuityBullets[0] }, { timeoutMs: 45_000 });
    const tools = await probe.eventually(() => probe.dom('[data-tool-aggregate][data-tool-lifecycle="completed"]'), {
      within: 10_000, label: "the command result without another message", until: (value) => value.elements.length > 0,
    });
    expect(tools.elements.length).toBeGreaterThan(0);
    await user.notSee({ text: /Status unknown/ });
    await user.see(stop);
    await user.screenshot();
  });
  await step("after: the same answer keeps growing after another interruption without a follow-up", async () => {
    const connections = await reconnect();
    await world.releaseReply();
    await user.see({ text: streamedContinuityBullets[1] }, { timeoutMs: 15_000 });
    await user.see({ text: streamedContinuityBullets[0] });
    await user.see(stop);
    await world.releaseReply(10);
    await user.see({ text: streamedContinuityBullets[9] }, { timeoutMs: 30_000 });
    await user.see("Run task", { timeoutMs: 15_000 });
    const messages = await readTranscriptMessages(probe, "assistant");
    const text = normalizedLines(messages.join("\n"));
    for (const bullet of streamedContinuityBullets) expect(occurrences(text, bullet)).toBe(1);
    const requests = await world.engineHttpEvents();
    expect(requests.promptPosts).toEqual({ [world.session.sessionId]: 1 });
    expect(await readTranscriptMessages(probe, "user")).toHaveLength(1);
    await user.notSee({ text: /Status unknown/ });
    await user.screenshot();
  });
});
