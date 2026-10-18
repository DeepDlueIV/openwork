import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { streamFeedback, streamFeedbackPrompt, streamFeedbackReasoning, streamFeedbackText, streamFeedbackTail } from "../worlds/stream-feedback.ts";
import { streamFeedbackDistribution, summarizeStreamFeedback } from "../worlds/stream-feedback-summary.ts";

const test = spec.world(streamFeedback, {
  timeout: 240_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

// A measurement/regression proof of EXISTING v2 streaming: baseline should pass.
// Samples are deltas in one turn, not independent turns. DOM/rAF are not physical paint.
// The 300 ms p95 budget is specific to this small loopback fixture, not a model/task SLA.
const frameP95BudgetMs = 300;

test("a member sees reasoning and an answer grow before the model finishes", async ({ world, user, probe, step, evidence }) => {
  await step("before: reasoning stays collapsed while the first real deltas arrive", async () => {
    await user.type("composer", streamFeedbackPrompt);
    await user.click("Run task");
    await user.see({ role: "button", label: "Thinking…" }, { timeoutMs: 60_000 });
    await user.notSee({ text: "r00" });
    const received = await probe.eventually(() => world.feedback(), {
      within: 15_000, label: "native reasoning delta receipt", until: value => value.excludedCollapsedReasoning > 0,
    });
    expect(received.trustedSendAt).not.toBeNull();
    expect(received.firstDeltaAt).not.toBeNull();
    expect(received.disclosureAt).toBeNull();
    evidence.recordAssertionEvidence("Real deltas do not open the reasoning disclosure", JSON.stringify({
      streams: received.streams, trustedSendAt: received.trustedSendAt, firstDeltaAt: received.firstDeltaAt,
      excludedCollapsedReasoning: received.excludedCollapsedReasoning, disclosureAt: received.disclosureAt,
    }), received.streams > 0 && received.trustedSendAt !== null && received.disclosureAt === null);
    await user.screenshot();
  });

  await step("after: opening reasoning reveals incremental feedback while the answer is still held", async () => {
    await user.click({ role: "button", label: "Thinking…" });
    await user.see({ text: "r00" });
    const feedback = await probe.eventually(() => world.feedback(), {
      within: 30_000, label: "all native reasoning deltas and their visible frames",
      until: value => value.excludedCollapsedReasoning + value.samples.filter(sample => sample.kind === "reasoning").length === streamFeedbackReasoning.length
        && value.samples.every(sample => sample.frameAt !== null),
    });
    const held = await world.providerState();
    const reasoning = feedback.samples.filter(sample => sample.kind === "reasoning");
    expect(reasoning.length).toBeGreaterThanOrEqual(20);
    expect(feedback.disclosureAt).not.toBeNull();
    expect(feedback.terminalAt).toBeNull();
    expect(held.complete).toBe(false);
    expect(held.deliveredChunks).toBe(0);
    expect(reasoning.every(sample => sample.terminalAtFrame === false)).toBe(true);
    const lastArrival = reasoning.at(-1)?.receivedAt ?? 0;
    expect(reasoning.filter(sample => sample.frameAt !== null && sample.frameAt < lastArrival).length).toBeGreaterThanOrEqual(20);
    const dom = streamFeedbackDistribution(reasoning.map(sample => (sample.domAt ?? NaN) - sample.receivedAt));
    const frame = streamFeedbackDistribution(reasoning.map(sample => (sample.frameAt ?? NaN) - sample.receivedAt));
    expect(frame.p95Ms).toBeLessThan(frameP95BudgetMs);
    evidence.recordAssertionEvidence("Reasoning reaches visible DOM and frame callbacks before later deltas and completion", JSON.stringify({
      dom, frame, excludedBeforeDisclosure: feedback.excludedCollapsedReasoning,
      submitToFirstNativeDeltaMs: (feedback.firstDeltaAt ?? NaN) - (feedback.trustedSendAt ?? NaN),
      promptPostToFirstNativeDeltaMs: (feedback.firstDeltaAt ?? NaN) - (feedback.promptPostAt ?? NaN),
      preArrivalIncludes: "submission, engine, provider and transport; excluded from app feedback distributions",
      providerComplete: held.complete, deliveredTextChunks: held.deliveredChunks,
      boundary: "browser native SSE receipt -> matching viewport DOM -> rAF observation, not display-device paint",
    }), reasoning.length >= 20 && !held.complete && frame.p95Ms < frameP95BudgetMs);
    await user.screenshot();
  });

  await step("after: each released answer chunk becomes visible before the next one or completion", async () => {
    for (const chunk of streamFeedbackText) {
      await world.releaseText();
      await probe.eventually(() => world.feedback(), {
        within: 15_000, label: `visible frame for ${chunk.trim()}`,
        until: value => value.samples.some(sample => sample.kind === "text" && sample.token === chunk.trim() && sample.frameAt !== null),
      });
      if (chunk === streamFeedbackText[0]) await user.screenshot();
    }
    await user.see({ text: "t23" });
    await user.notSee({ text: streamFeedbackTail });
    const feedback = await world.feedback();
    const held = await world.providerState();
    const summary = summarizeStreamFeedback(feedback.samples);
    expect(feedback.errors).toBe(0);
    expect(feedback.terminalAt).toBeNull();
    expect(held.complete).toBe(false);
    expect(held.deliveredChunks).toBe(streamFeedbackText.length);
    expect(feedback.samples.filter(sample => sample.kind === "text")).toHaveLength(streamFeedbackText.length);
    for (const distribution of summary) expect(distribution.frame.p95Ms).toBeLessThan(frameP95BudgetMs);
    evidence.recordAssertionEvidence("Text and reasoning have separate per-delta n, p50 and p95 before completion", JSON.stringify({
      summary, samples: feedback.samples, frameP95BudgetMs, providerComplete: held.complete,
      boundary: "native SSE receipt in a read-only browser tee; DOM and animation frames, not physical paint",
    }), summary.every(item => item.frame.p95Ms < frameP95BudgetMs) && !held.complete);
  });

  await step("after: only releasing the final sentence lets the model finish", async () => {
    await world.releaseText();
    await user.see({ text: streamFeedbackTail });
    await user.notSee({ role: "button", label: "Stop" }, { timeoutMs: 30_000 });
    const completed = await probe.eventually(() => world.providerState(), {
      within: 15_000, label: "the provider really completed", until: value => value.complete,
    });
    expect(completed.aborted).toBe(false);
    expect(completed.timedOut).toBe(false);
    evidence.recordAssertionEvidence("Completion follows the final release, not the earlier visible partial answer", JSON.stringify(completed),
      completed.complete && !completed.aborted && !completed.timedOut);
    await user.screenshot();
  });
});
