import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { engineConnectorNeedsSignIn } from "../worlds/engine-connectors-parity.ts";

// Web app + a real Den per-member Notion connection the member hasn't connected yet,
// reached through OpenWork Cloud: direct calls on v1, one Code Mode `execute` on v2.
const test = spec.world(engineConnectorNeedsSignIn, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const PROMPT = "Find our roadmap page in Notion.";
const REPLY = "Notion needs you to connect it first.";
const CONTINUE = "Notion is connected. Go ahead.";
const FOUND = "Your roadmap page is in Notion.";
const CARD = '[data-testid="desktop-connection-card"]';

test(`AGENT-VIS-06 ${resolveEvalEngine()}: a person asks for something in a service they haven't connected, gets a Connect card, and the chat carries on once they sign in`, async ({ world, user, probe, step, evidence }) => {
  await step("the person asks for their Notion roadmap page", async () => {
    await world.prepareNeedsSignIn(PROMPT, REPLY);
    await user.type("composer", PROMPT);
    await user.click("Run task");
    await user.see({ text: PROMPT });
  });

  await step("after: the chat offers to connect Notion instead of showing an error", async () => {
    await user.see({ text: REPLY }, { timeoutMs: 90_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    const cards = await probe.eventually(async () => (await probe.dom(CARD)).elements, {
      within: 15_000, intervalMs: 250, label: "a connection card", until: (elements) => elements.length > 0,
    }).catch(() => []);
    const text = cards.map((card) => card.text).join(" | ");
    evidence.recordAssertionEvidence("A Connect card names the service",
      cards.length ? `card reads "${text.slice(0, 160)}"` : "no connection card in the chat", cards.length === 1 && /Notion/.test(text));
    expect(cards).toHaveLength(1);
    expect(text).toMatch(/Notion/);
    await user.see({ role: "button", label: /Connect/ });
    await user.notSee({ text: /needs_connection|connectionStatus|openwork-cloud_/ });
    await user.screenshot();
  });

  await step("after: the person signs in to Notion from the card and the chat carries on without them typing", async () => {
    await world.prepareTurn(CONTINUE, FOUND);
    await user.click({ role: "button", label: /Connect/ });
    const connected = await probe.eventually(async () => {
      const response = await probe.api(world.den.admin, "/v1/mcp-connections?scope=usable");
      return JSON.stringify(response.body).includes('"connectedForMe":true');
    }, { within: 90_000, intervalMs: 1_000, label: "Den reports Notion connected for the person", until: (value) => value });
    await user.see({ text: CONTINUE }, { timeoutMs: 60_000 });
    await user.see({ text: FOUND }, { timeoutMs: 90_000 });
    evidence.recordAssertionEvidence("Signing in from the card carries the chat on",
      `Den connectedForMe=${connected}; the chat sent "${CONTINUE}" by itself and the agent answered "${FOUND}"`, connected);
    expect(connected).toBe(true);
    await user.screenshot();
  });
});
