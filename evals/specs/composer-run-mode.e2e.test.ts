import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { emptyDesktopSession } from "../worlds/desktop.ts";

const test = spec.world(emptyDesktopSession, {
  resources: {
    surfaces: ["desktop"],
    services: [],
    nativeReason: "Workspace run mode is offered only with the standard desktop engine; the switch is disabled in a browser.",
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("workspace run mode is opt-in, confirms Keep going, and preserves policy when hidden", async ({ world, user, probe, step, evidence }) => {
  const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}`;
  const trigger = { testId: "workspace-run-mode-trigger" };
  const flag = { testId: "workspace-run-mode-flag", label: "Show workspace run mode" };
  const confirmation = { text: "Let OpenWork keep going?" };
  const footer = { text: "Applies to every chat in this workspace. Specific workspace rules still apply." };

  const read = async (path: string) => {
    const response = await probe.desktopApi(`${mount}/${path}`);
    expect(response.status, `${path} ${JSON.stringify(response.body)}`).toBe(200);
    if (!isRecord(response.body)) throw new Error(`Expected an object from ${path}.`);
    return response.body;
  };
  // updatedAt includes runtime reattachment on reload, not just permission
  // edits. Compare configuration values rather than that unrelated clock.
  const readConfig = async () => {
    const { opencode, openwork } = await read("config");
    return { opencode, openwork };
  };
  const flagEnabled = () => probe.storage("openwork.preferences", (value) => (
    isRecord(value) && isRecord(value.featureFlags) && value.featureFlags.workspaceRunMode === true
  ));
  const modeIs = async (mode: "default" | "approve" | "run-everything", catchAll: "ask" | "allow" | null) => {
    const state = await probe.eventually(() => read("permissions/mode"), {
      within: 60_000,
      label: `workspace persists ${mode}`,
      until: (value) => value.mode === mode && value.catchAll === catchAll && value.refreshPending !== true,
    });
    expect(state).toMatchObject({ mode, catchAll, supported: true, path: expect.any(String) });
    return state;
  };
  const mcpRow = async () => {
    const effective = await read("permissions/effective");
    if (!Array.isArray(effective.rows)) throw new Error("Effective permissions did not return rows.");
    const row = effective.rows.find((value) => isRecord(value) && value.key === "mcp");
    if (!isRecord(row)) throw new Error("Effective permissions did not return an MCP row.");
    return row;
  };
  const mcpIs = async (action: "ask" | "allow") => {
    const row = await probe.eventually(mcpRow, {
      within: 60_000,
      label: `engine applies workspace MCP ${action}`,
      until: (value) => value.action === action && value.source === "workspace",
    });
    expect(row).toMatchObject({ action, source: "workspace", rule: { permission: "*", pattern: "*", action } });
  };
  const advanced = async () => {
    await user.click({ testId: "account-status-menu" });
    await user.click("Settings");
    await user.click("Advanced");
    await user.see(flag);
  };
  const menu = async (label: string) => {
    await user.see({ ...trigger, label: `Workspace run mode: ${label}` });
    await user.click(trigger);
    await user.see(footer);
    await user.see({ testId: "run-mode-default", label: "Workspace defaults" });
    await user.see({ testId: "run-mode-approve", label: "Ask before actions" });
    await user.see({ testId: "run-mode-run-everything", label: "Keep going" });
  };
  const confirmationClosed = async () => {
    await probe.eventually(() => probe.has(confirmation.text), {
      within: 60_000, label: "Keep going confirmation dismissed", until: (visible) => !visible,
    });
    await user.notSee(confirmation);
  };

  await user.see("composer", { editable: true });
  await user.press("Escape");
  const initialMode = await modeIs("default", null);
  const initialMcp = await mcpRow();

  await step("before: the isolated desktop has an editable chat and inherited workspace permissions", async () => {
    await user.see("composer", { editable: true });
    evidence.recordAssertionEvidence("run-mode doctor: the owned desktop is usable before input", JSON.stringify({ route: await probe.hash(), initialMode, initialMcp }), true);
    await user.screenshot();
  });

  await step("the control is absent until enabled in Advanced, without a policy write", async () => {
    expect(await flagEnabled()).toBe(false);
    await user.notSee(trigger);
    const before = await readConfig();
    await advanced();
    await user.click(flag);
    expect(await probe.eventually(flagEnabled, { within: 5_000, label: "run mode flag enabled" })).toBe(true);
    await user.click("Back to app");
    await menu("Workspace defaults");
    expect(await read("permissions/mode")).toEqual(initialMode);
    expect(await readConfig()).toEqual(before);
    evidence.recordAssertionEvidence("showing workspace run mode does not write policy", JSON.stringify({ enabled: await flagEnabled(), mode: await read("permissions/mode") }), true);
    await user.screenshot();
  });

  await step("Ask before actions persists a workspace catch-all and reaches the engine", async () => {
    await user.click({ testId: "run-mode-approve" });
    await modeIs("approve", "ask");
    expect(await read("config")).toMatchObject({ opencode: { permission: { "*": "ask" } } });
    await mcpIs("ask");
    await user.see({ ...trigger, label: "Workspace run mode: Ask before actions" });
    await user.reload();
    await user.see({ ...trigger, label: "Workspace run mode: Ask before actions" });
    expect(await flagEnabled()).toBe(true);
    evidence.recordAssertionEvidence("Ask before actions survives reload and reaches the engine", JSON.stringify({ mode: await read("permissions/mode"), config: await readConfig(), effectiveMcp: await mcpRow() }), true);
    await user.screenshot();
  });

  await step("opening and cancelling Keep going leaves saved and effective permissions unchanged", async () => {
    const beforeMode = await read("permissions/mode");
    const beforeConfig = await readConfig();
    const beforeMcp = await mcpRow();
    await menu("Ask before actions");
    await user.click({ testId: "run-mode-run-everything" });
    await user.see(confirmation);
    await user.see({ role: "button", label: "Enable Keep going" });
    await user.screenshot();
    expect(await read("permissions/mode")).toEqual(beforeMode);
    expect(await readConfig()).toEqual(beforeConfig);
    expect(await mcpRow()).toEqual(beforeMcp);
    await user.click({ role: "button", label: "Cancel" });
    await confirmationClosed();
    await user.see({ ...trigger, label: "Workspace run mode: Ask before actions" });
    expect(await read("permissions/mode")).toEqual(beforeMode);
    expect(await readConfig()).toEqual(beforeConfig);
    expect(await mcpRow()).toEqual(beforeMcp);
    evidence.recordAssertionEvidence("cancelling Keep going preserves saved and effective policy", JSON.stringify({ mode: await read("permissions/mode"), config: await readConfig(), effectiveMcp: await mcpRow() }), true);
    await user.screenshot();
  });

  await step("only confirming Keep going changes the workspace and effective MCP action to allow", async () => {
    await menu("Ask before actions");
    await user.click({ testId: "run-mode-run-everything" });
    await user.see(confirmation);
    await user.click({ role: "button", label: "Enable Keep going" });
    await confirmationClosed();
    await modeIs("run-everything", "allow");
    expect(await read("config")).toMatchObject({ opencode: { permission: { "*": "allow" } } });
    await mcpIs("allow");
    await user.see({ ...trigger, label: "Workspace run mode: Keep going" });
    evidence.recordAssertionEvidence("only confirmation changes saved and effective policy to allow", JSON.stringify({ mode: await read("permissions/mode"), config: await readConfig(), effectiveMcp: await mcpRow() }), true);
    await user.screenshot();
  });

  await step("Workspace defaults removes the catch-all and restores inherited MCP permissions", async () => {
    await menu("Keep going");
    await user.click({ testId: "run-mode-default" });
    expect(await modeIs("default", null)).toEqual(initialMode);
    const config = await read("config");
    if (!isRecord(config.opencode)) throw new Error("Workspace config did not return opencode.");
    expect(config.opencode).not.toHaveProperty(["permission", "*"]);
    const restored = await probe.eventually(mcpRow, {
      within: 60_000,
      label: "inherited MCP permissions restored",
      until: (value) => value.action === initialMcp.action && value.source === initialMcp.source,
    });
    expect(restored).toEqual(initialMcp);
    await user.see({ ...trigger, label: "Workspace run mode: Workspace defaults" });
    evidence.recordAssertionEvidence("workspace defaults restores inherited permissions", JSON.stringify({ mode: await read("permissions/mode"), config: await readConfig(), effectiveMcp: restored }), true);
    await user.screenshot();
  });

  await step("turning the flag off hides only the control, even with a non-default policy saved", async () => {
    await menu("Workspace defaults");
    await user.click({ testId: "run-mode-approve" });
    const beforeMode = await modeIs("approve", "ask");
    await mcpIs("ask");
    const beforeConfig = await readConfig();
    const beforeMcp = await mcpRow();
    await advanced();
    await user.click(flag);
    expect(await probe.eventually(flagEnabled, {
      within: 5_000, label: "run mode flag disabled", until: (enabled) => !enabled,
    })).toBe(false);
    await user.click("Back to app");
    await user.see("composer", { editable: true });
    await user.notSee(trigger);
    await user.reload();
    await user.see("composer", { editable: true });
    await user.notSee(trigger);
    expect(await flagEnabled()).toBe(false);
    expect(await read("permissions/mode")).toEqual(beforeMode);
    expect(await readConfig()).toEqual(beforeConfig);
    expect(await mcpRow()).toEqual(beforeMcp);
    evidence.recordAssertionEvidence("hiding the control preserves saved and effective policy after reload", JSON.stringify({ mode: await read("permissions/mode"), config: await readConfig(), effectiveMcp: await mcpRow() }), true);
    await user.screenshot();
  });
});
