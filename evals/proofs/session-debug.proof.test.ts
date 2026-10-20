import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sessionDebug } from "../worlds/session-debug.ts";

const test = spec.world(sessionDebug, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { commands: ["bun"] },
});

test("a developer inspects provider routing and copies the focused thread from session diagnostics", async ({ world, user, probe, step, evidence }) => {
  const panel = '[data-testid="session-debug-panel"]';
  const rect = async () => (await probe.dom(panel)).elements[0]!.rect;
  const copied = (until: (text: string) => boolean) => probe.eventually(world.readClipboard, {
    within: 5_000, label: "the focused copy action reaches the real clipboard", until,
  });

  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("before: conversation diagnostics stay hidden until developer mode is enabled", async () => {
    await user.see("composer");
    await user.notSee({ testId: "session-debug-panel" });
    const count = (await probe.dom(panel)).elements.length;
    expect(count).toBe(0);
    evidence.recordAssertionEvidence("Normal conversations have no debug overlay", `debug panels=${count}`, count === 0);
    await user.screenshot();
  });

  await step("after: developer mode shows versions, waiting state and measured connection health", async () => {
    await user.press(world.paletteShortcut);
    await user.see({ role: "combobox" });
    await user.type({ role: "combobox" }, "Enable Developer Mode");
    await user.click({ text: "Enable Developer Mode" });
    await user.see({ testId: "session-debug-panel" });
    const text = await probe.eventually(async () => (await probe.dom(panel)).elements[0]?.text ?? "", {
      within: 20_000, label: "diagnostics receive real connection health", until: text => text.includes("Connected") && /Health RTT \d+ ms/.test(text),
    });
    expect(text).toContain("Waiting on");
    expect(text).toContain("OpenCode");
    expect(text).toMatch(/Health RTT \d+ ms/);
    expect(text).not.toContain("Intended session");
    evidence.recordAssertionEvidence("Compact diagnostics use real health responses", text, /Health RTT \d+ ms/.test(text));
    await user.screenshot();
  });

  await step("Resources names the real pending load and shows it finish", async () => {
    await user.click({ role: "tab", label: "Resources" });
    await user.see({ testId: "session-debug-resources" });
    const before = world.healthReads();
    world.holdNextHealthRead();
    await user.click({ role: "button", label: "Refresh diagnostics" });
    await probe.eventually(() => world.healthReads(), { within: 5_000, label: "the real health read is held", until: count => count > before });
    const loading = await probe.eventually(async () => (await probe.dom('[data-debug-resource="Connection health"]')).elements[0]?.text ?? "", {
      within: 5_000, label: "the pending health resource has an elapsed time", until: text => /Loading/.test(text) && /[1-9]\d*\.\ds/.test(text),
    });
    expect(loading).toContain("Loading");
    const loadingBounds = (await probe.dom('[data-debug-resource="Connection health"]')).elements[0]!.rect;
    const panelBounds = await rect();
    expect(loadingBounds.top).toBeGreaterThan(panelBounds.top);
    expect(loadingBounds.bottom).toBeLessThan(panelBounds.bottom - 80);
    evidence.recordAssertionEvidence("The Resources tab shows an actual in-flight load with elapsed time", `held reads=${world.healthReads() - before}; resource=${loading}`, world.healthReads() > before && /Loading/.test(loading));
    await user.screenshot();
    const loaded = await probe.eventually(async () => (await probe.dom('[data-debug-resource="Connection health"]')).elements[0]?.text ?? "", {
      within: 10_000, label: "the same resource finishes loading", until: text => text.includes("Loaded"),
    });
    expect(loaded).toContain("Loaded");
    await user.click({ role: "tab", label: "Overview" });
    await user.see({ text: /^Connected$/ });
  });

  await step("Providers distinguishes configured models from observed replies", async () => {
    await user.click({ role: "tab", label: "Providers" });
    await user.see({ testId: "session-debug-providers" });
    const before = await probe.eventually(async () => (await probe.dom('[data-testid="session-debug-providers"]')).elements[0]?.text ?? "", {
      within: 15_000, label: "the focused thread has configuration but no response evidence", until: text => text.includes("Configured") && text.includes("No response in recent history"),
    });
    expect(before).toContain("Not reported");
    expect(before).not.toContain("Response observed");
    evidence.recordAssertionEvidence("Configuration alone never claims a working provider response", before, before.includes("Configured") && !before.includes("Response observed"));
    await user.screenshot();
  });

  await step("after: a real round trip appears in the focused thread's provider details", async () => {
    await user.type("composer", world.prompt);
    await user.press("Enter");
    await user.see({ text: world.reply }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Refresh provider details" });
    const after = await probe.eventually(async () => (await probe.dom('[data-testid="session-debug-providers"]')).elements[0]?.text ?? "", {
      within: 15_000, label: "the response is observed for the focused thread", until: text => text.includes("Response observed"),
    });
    const requests = await world.providerReplies();
    expect(requests.some(request => request.kind === "final")).toBe(true);
    await user.click({ role: "button", label: "Copy thread" });
    const transcript = await copied(text => text.includes(world.reply));
    expect(transcript).toContain(world.prompt);
    expect(transcript).toContain(world.reply);
    await user.click({ role: "button", label: "Copy provider details" });
    const diagnostics = await copied(text => text.includes(world.session.sessionId));
    expect(diagnostics).toContain(world.session.sessionId);
    expect(diagnostics).not.toContain(world.prompt);
    expect(diagnostics).not.toContain(world.reply);
    expect(diagnostics).not.toContain("synthetic-key");
    expect(diagnostics).not.toContain("baseURL");
    evidence.recordAssertionEvidence("A witnessed model response is scoped to this thread and its two copy actions", `${requests.length} model requests; ${after}; transcript includes this prompt and reply, while diagnostic export omits them and credentials`, requests.some(request => request.kind === "final") && after.includes("Response observed"));
    await user.screenshot();
  });

  await step("inspecting another provider does not change the thread's model or borrow its response evidence", async () => {
    await user.click({ role: "combobox", label: "Inspect provider" });
    await user.click({ role: "option", label: "Secondary provider" });
    const inspected = await probe.eventually(async () => (await probe.dom('[data-testid="session-debug-providers"]')).elements[0]?.text ?? "", {
      within: 10_000, label: "secondary provider has its own configuration and no responses", until: text => text.includes("Secondary model") && text.includes("No response in recent history"),
    });
    expect(inspected).not.toContain("Response observed");
    await user.click({ role: "button", label: "Copy provider details" });
    const diagnostics = await copied(text => text.includes('"inspectedProvider": "debug-secondary"'));
    expect(diagnostics).toContain('"inspectedProvider": "debug-secondary"');
    expect(diagnostics).toContain('"Thread model": "opencode / big-pickle"');
    evidence.recordAssertionEvidence("Provider inspection is read-only and response evidence never crosses provider identities", inspected, diagnostics.includes('"Thread model": "opencode / big-pickle"') && !inspected.includes("Response observed"));
    await user.screenshot();
  });

  await step("focusing another conversation resets provider inspection and copies only that thread", async () => {
    await user.click({ text: /^Independent conversation$/ });
    await user.click({ role: "tab", label: "Providers" });
    await user.see({ testId: "session-debug-providers" });
    await user.click({ role: "button", label: "Copy provider details" });
    const diagnostics = await copied(text => text.includes(world.otherSession.sessionId));
    expect(diagnostics).toContain(world.otherSession.sessionId);
    expect(diagnostics).not.toContain(world.session.sessionId);
    expect(diagnostics).toContain('"inspectedProvider": "opencode"');
    await user.click({ role: "button", label: "Copy thread" });
    const transcript = await copied(text => text === "");
    expect(transcript).not.toContain(world.prompt);
    expect(transcript).not.toContain(world.reply);
    evidence.recordAssertionEvidence("Focused-thread diagnostics and clipboard exclude the other conversation", `thread=${world.otherSession.sessionId}; previous thread and conversation text absent`, !diagnostics.includes(world.session.sessionId) && !transcript.includes(world.reply));
    await user.screenshot();
    await user.click({ role: "tab", label: "Overview" });
  });

  await step("the panel moves and resizes using its keyboard-accessible handles", async () => {
    const before = await rect();
    await user.click({ role: "button", label: "Move session debug" });
    await user.press("ArrowLeft");
    await user.press("ArrowUp");
    await user.click({ role: "button", label: "Resize session debug" });
    await user.press("ArrowRight");
    await user.press("ArrowDown");
    const after = await rect();
    expect(after.left).toBe(before.left - 10);
    expect(after.top).toBe(before.top - 10);
    expect(after.width).toBe(before.width + 10);
    expect(after.height).toBe(before.height + 10);
    await user.click({ role: "button", label: "More details" });
    await user.see({ text: "Intended session" });
    evidence.recordAssertionEvidence("Move, resize and details work in the conversation", `before=${JSON.stringify(before)}; after=${JSON.stringify(after)}`, after.width > before.width && after.left < before.left);
    await user.screenshot();
  });

  await step("dismissal is reversible and resizing the viewport keeps the controls reachable", async () => {
    await user.click({ role: "button", label: "Dismiss session debug" });
    await user.notSee({ testId: "session-debug-panel" });
    await user.see("composer");
    await user.click({ role: "button", label: "Show session debug" });
    await user.resizeViewport({ width: 640, height: 480, deviceScaleFactor: 1 });
    const bounds = await probe.eventually(rect, { within: 5_000, label: "debug panel stays in the smaller viewport", until: value => value.right <= 640 && value.bottom <= 480 });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    await user.see({ role: "button", label: "Dismiss session debug" });
    evidence.recordAssertionEvidence("Reopening retains a usable panel on a smaller window", JSON.stringify(bounds), bounds.right <= 640 && bounds.bottom <= 480);
    await user.screenshot();
  });
});
