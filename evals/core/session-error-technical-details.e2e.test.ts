import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  chatErrorDetailsPanel, chatErrorDetailsToggle, chatSeeStorageErrorBanner, chatSeeStorageErrorGuidance,
  chatStorageErrorDescription, chatStorageErrorTitle, chatToggleDeveloperMode,
} from "@openwork/behaviors";
import { sessionErrorCard, sessionProviderErrorRecovery, sessionSubmitErrorIsolation } from "../worlds/chat.ts";

const test = spec.world(sessionErrorCard);
const submitTest = spec.world(sessionSubmitErrorIsolation, { timeout: 600_000 });
const providerTest = spec.world((seed) => sessionProviderErrorRecovery(seed, { terminalRejection: true, retiredSavedModel: true }), { timeout: 600_000 });

// Values from the seeded payload (eval.session_error.seed): an Anthropic 429
// with a JSON response body. None of these appear in the plain card text.
const CARD_TEXT = "This model is receiving too many requests";
const DIAGNOSTIC_LINES = ["Error type: APIError", "Status: 429", "Provider: anthropic", "Code: rate_limit_error", "Retries: 3"];
const REQUEST_ID = "req_01JZK4W9N7X2Q8M3V5T6B1C0DE";
// Rendered with CSS uppercase, so compare case-insensitively.
const DEBUG_PANEL_TITLE = /react session debug/i;

const detailsToggle = chatErrorDetailsToggle;
const detailsPanel = chatErrorDetailsPanel;
const statusLine = { text: /Status: 429/ };
const requestId = { text: new RegExp(REQUEST_ID) };

// A failed turn in the transcript keeps its raw error one click away for
// everyone (behind the code icon that appears on hover or focus); the session
// error banner and the React session debug panel stay Developer-mode only.
test("session error cards keep provider diagnostics behind Technical details; the error banner shows them only in Developer mode", async ({ user, probe, step, world, place }) => {
  const mac = place.kind !== "daytona" && process.platform === "darwin";
  // Closing the disclosure fades the panel out; wait for that to finish
  // before requiring it to stay hidden.
  const detailsClosed = () => probe.eventually(() => probe.dom('[data-testid="session-error-details"]'), {
    within: 10_000,
    label: "Technical details closed",
    until: (value) => value.elements.every((element) => element.rect.height === 0),
  });

  await step("a failed turn shows only the plain error card until a person points at it", async () => {
    await user.see({ text: new RegExp(CARD_TEXT) });
    await user.notSee(detailsToggle);
    await user.notSee(statusLine);
    await user.notSee(requestId);
    await user.notSee({ text: DEBUG_PANEL_TITLE });
  });

  await step("pointing at the card reveals a collapsed Technical details control outside Developer mode", async () => {
    await user.hover({ text: new RegExp(CARD_TEXT) });
    await user.see(detailsToggle);
    // The disclosure starts collapsed: the toggle is present, the panel is not.
    await user.notSee(detailsPanel);
    await user.notSee(statusLine);
    await user.notSee({ text: DEBUG_PANEL_TITLE });
  });

  await step("opening Technical details shows the full provider diagnostic payload with a copy action", async () => {
    await user.click(detailsToggle);
    await user.see(detailsPanel);
    for (const line of DIAGNOSTIC_LINES) await user.see({ text: new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    // The request id sits inside the raw response-body block, so match it within that block's text.
    await user.see(requestId);
    await user.see({ role: "button", label: /^copy$/i });
  });

  await step("closing Technical details hides the payload while the error card remains", async () => {
    await user.click(detailsToggle);
    await detailsClosed();
    await user.notSee(detailsPanel);
    await user.notSee(statusLine);
    await user.notSee(requestId);
    await user.see({ text: new RegExp(CARD_TEXT) });
  });

  await step("Developer mode adds the session debug panel without a reload, and turning it off removes the panel", async () => {
    await chatToggleDeveloperMode(user, "on", { mac });
    await user.see({ text: DEBUG_PANEL_TITLE }, { timeoutMs: 10_000 });
    await user.see({ text: new RegExp(CARD_TEXT) });
    await user.notSee(detailsPanel);
    await chatToggleDeveloperMode(user, "off", { mac });
    await user.notSee({ text: DEBUG_PANEL_TITLE }, { timeoutMs: 10_000 });
    await user.see({ text: new RegExp(CARD_TEXT) });
    await user.notSee(statusLine);
  });

  const storageErrors: Array<"disk-full" | "database-error"> = ["disk-full", "database-error"];
  for (const kind of storageErrors) {
    await step(`${kind} shows recovery guidance and keeps the stack trace behind Technical details`, async () => {
      await world.seedStorageError(kind);
      await chatSeeStorageErrorGuidance(user, kind, detailsClosed);
    });
    await step(`${kind} banner hides the stack trace outside Developer mode`, async () => {
      await world.seedStorageError(kind, "banner");
      await chatSeeStorageErrorBanner(user, kind, { mac });
    });
  }

  await step("when the conversation's history fails to load, the composer stays usable and typing sends nothing", async () => {
    const before = await probe.composer();
    await world.failSnapshot();
    await user.see("composer", { editable: true, timeoutMs: 30_000 });
    const draft = "Draft survives the broken history without being sent 9472.";
    await user.type("composer", draft);
    await user.see("composer", { editable: true, text: draft, timeoutMs: 30_000 });
    expect((await probe.composer()).userMessageCount).toBe(before.userMessageCount);
  });
});

providerTest("a model server failure retries clearly and leaves one completed answer; a refused request says why and the composer is ready again", async ({ user, probe, step, world }) => {
  const option = (model: { providerID: string; modelID: string }) => ({ testId: `model-option-${model.providerID}-${model.modelID}` });
  await step("a saved model the provider dropped stays named in the picker with a reason and one way to recover", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.see({ testId: "retained-selected-model" });
    await user.see({ text: /no longer available here/ });
    await user.see({ text: "Your saved model isn’t available here anymore." });
    await user.see({ role: "button", label: "Refresh" });
    await user.see(option(world.models.kept));
    await user.notSee(option(world.models.retired));
    await user.screenshot();
    await user.click(option(world.models.kept));
    await user.see({ role: "button", label: "Change model" }, { text: world.models.kept.name });
  });
  await step("a real provider 500 is explained without exposing the raw error", async () => {
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await user.see({ testId: "session-retrying" }, { timeoutMs: 45_000 });
    await user.see({ text: "The model couldn’t respond. Retrying…" });
    await user.notSee({ text: "Internal server error" });
    await user.notSee({ testId: "admission-outcome-unknown" });
    await user.hover({ text: "The model couldn’t respond. Retrying…" });
    await user.click(detailsToggle);
    await user.see({ text: /attempt [12]/ });
  });
  await step("automatic recovery clears retry and unresolved-outcome notices", async () => {
    await user.see({ text: world.reply }, { timeoutMs: 60_000 });
    await user.notSee({ testId: "session-retrying" });
    await user.notSee({ testId: "admission-outcome-unknown" });
    const calls = await world.mock.agentRequests({ promptMarker: world.prompt });
    expect(calls.filter(call => call.kind === "error")).toHaveLength(2);
    expect(calls.filter(call => call.kind === "final")).toHaveLength(1);
    expect(calls.filter(call => call.kind === "tool")).toHaveLength(0);
    const visible = await probe.dom('[data-session-surface-id]');
    expect(visible.elements.length).toBeGreaterThan(0);
    await user.reload();
    await user.see({ text: world.reply });
    await user.notSee({ testId: "session-retrying" });
    await user.notSee({ testId: "admission-outcome-unknown" });
  });
  await step("a request the provider refuses before any answer shows the provider's reason, and the composer is ready again", async () => {
    await user.type("composer", world.rejected.prompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: world.rejected.message }, { timeoutMs: 45_000 });
    await user.see({ role: "button", label: "Run task" }, { timeoutMs: 30_000 });
    // The sent words are in the transcript, not bounced back into the composer as a silent draft.
    await user.see("composer", { editable: true, text: "" });
    await user.notSee({ testId: "session-retrying" });
    const calls = await world.mock.agentRequests({ promptMarker: world.rejected.prompt });
    expect(calls.filter((call) => call.kind === "error").length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((call) => call.kind === "final")).toHaveLength(0);
    await user.screenshot();
  });
});

submitTest("a delayed submit error stays with its owner while another retained task remains sendable", async ({ user, probe, step, world }) => {
  const a = world.sessionA.sessionId;
  const b = world.sessionB.sessionId;
  const banner = { testId: "session-error-card" };
  const select = async (title: string, sessionId: string) => {
    await user.click({ text: title });
    await probe.eventually(() => world.selectedSurface(), {
      within: 15_000, label: "the selected task owns the visible surface", until: value => value.sessionId === sessionId,
    });
  };
  const readyToSend = (sessionId: string) => probe.eventually(() => world.selectedSurface(), {
    within: 15_000, label: "the selected task can send", until: value => value.sessionId === sessionId && value.runEnabled,
  });
  const releaseFailure = async (count: number) => {
    await world.failHeldSubmissions();
    await probe.eventually(() => world.readSubmissions(), {
      within: 15_000, label: "the held SDK error response finishes", until: value => value.finished === count,
    });
    await world.settleResponse();
  };

  await step("A's real submit stays pending while B is selected and editable", async () => {
    await user.type("composer", "Save the first task output.", { verify: true });
    await readyToSend(a);
    await user.click({ role: "button", label: "Run task" });
    await probe.eventually(() => world.readSubmissions(), {
      within: 30_000, label: "A's actual submit is intercepted before its response", until: value => value.held === 1,
    });
    await select(world.sessionB.title, b);
    await user.type("composer", world.promptB, { verify: true });
    await readyToSend(b);
    expect(world.readSubmissions().finished).toBe(0);
  });

  await step("A's late upstream storage failure neither shows a B banner nor blocks B's one send", async () => {
    await releaseFailure(1);
    await user.notSee(banner);
    await user.notSee({ text: chatStorageErrorTitle });
    await user.see("composer", { editable: true, text: world.promptB });
    // Do not poll past an incorrect disabled state after the response settled.
    expect(await world.selectedSurface()).toEqual({ sessionId: b, runEnabled: true });
    await user.click({ role: "button", label: "Run task" });
    await user.see({ text: world.replyB }, { timeoutMs: 60_000 });
    expect(world.readSubmissions().requests.filter(request => request.sessionId === b)).toHaveLength(1);
    expect(world.readSubmissions().requests.find(request => request.sessionId === b)?.body).toContain(world.promptB);
    await user.notSee(banner);
  });

  await step("a failure delivered while A owns the surface remains visible with neutral storage guidance", async () => {
    await select(world.sessionA.title, a);
    await user.type("composer", "Save the first task output again.", { replace: true, verify: true });
    await readyToSend(a);
    await user.click({ role: "button", label: "Run task" });
    await probe.eventually(() => world.readSubmissions(), {
      within: 30_000, label: "A's own second submit reaches the same HTTP boundary", until: value => value.held === 2,
    });
    await releaseFailure(2);
    await user.see(banner);
    await user.see({ text: chatStorageErrorTitle });
    await user.see({ text: chatStorageErrorDescription });
    await user.notSee({ text: /EDQUOT/ });
    expect(await world.selectedSurface()).toEqual({ sessionId: a, runEnabled: false });
    await select(world.sessionB.title, b);
    await user.see({ text: world.replyB });
    await user.notSee(banner);
    expect(world.readSubmissions().requests.filter(request => request.sessionId === b)).toHaveLength(1);
  });
});
