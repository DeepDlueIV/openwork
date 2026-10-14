import { browserScript, evaluate, type Surface } from "@openwork/cdp";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { engineSessionProbe, observeSidebarExpansion, readAvailableModels, waitFor } from "@openwork/behaviors";
import { resolveEvalEngine, SkipError } from "@openwork/env";
import type { Place, Seed } from "@openwork/env";
import { daytonaSandbox, defaultDaytonaExec, execInSandbox, startMockOnSandbox } from "@openwork/hosts";
import { configureProvider } from "./chat.ts";

export interface ShellSession {
  sessionId: string;
  title: string;
}

export interface ShellWorkspace {
  workspaceId: string;
  route: string;
}

export interface StormPlan extends ShellSession, ShellWorkspace {
  index: number;
  path: string;
  filePath: string;
  marker: string;
  slowMarker: string;
  easyMarker: string;
  finalReply: string;
}

type InstantMetricKind = "new-task" | "hero-preparing" | "user-row";

type InstantRendererState = {
  kind: InstantMetricKind;
  started: boolean;
  trusted: boolean;
  elapsedMs: number | null;
  frames: number;
  mutations: number;
  consecutiveFrames: number;
  expired: boolean;
};

declare global {
  interface Window {
    __instantSendMetric?: { state: InstantRendererState; stop(): void };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function additionalWorkspace(
  seed: Seed,
  app: Awaited<ReturnType<Seed["desktop"]>>,
  path: string,
): Promise<ShellWorkspace> {
  const previous = await seed.evalIn(app, () => (localStorage.getItem("openwork.react.activeWorkspace") ?? ""));
  // TODO(primitive): seed.workspace should always create the requested additional workspace.
  const result = await seed.evalIn(app, browserScript((path) => window.__openworkControl.execute("workspace.create", { path }), [path]), { awaitPromise: true, timeoutMs: 120_000 });
  if (!isRecord(result) || result.ok !== true) throw new Error(`Could not create workspace ${path}: ${JSON.stringify(result)}`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = await seed.evalIn(app, () => (({
      workspaceId: localStorage.getItem("openwork.react.activeWorkspace") ?? "",
      route: window.location.hash,
      ready: Boolean(window.__openworkControl),
    })));
    if (isRecord(state)
      && typeof state.workspaceId === "string"
      && state.workspaceId
      && state.workspaceId !== previous
      && typeof state.route === "string"
      && state.ready === true) {
      return { workspaceId: state.workspaceId, route: state.route };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Workspace ${path} did not become active after creation.`);
}

async function configureWorkspaceProvider(
  seed: Seed,
  app: Awaited<ReturnType<Seed["desktop"]>>,
  workspaceIds: readonly string[],
  options: {
    providerId: string;
    modelId: string;
    modelName: string;
    baseUrl: string;
    smallModel?: string;
    allowTools?: boolean;
  },
): Promise<void> {
  // TODO(primitive): seed.configureWorkspaceProvider should configure and reload a workspace model without raw renderer evaluation.
  const result = await seed.evalIn(app, browserScript(async (workspaceIds, smallModel, allowTools, providerId, modelId, modelName, baseUrl, defaultModel) => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const root = String(info.baseUrl).replace(/\/+$/, "");
    const headers = {
      Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
      "Content-Type": "application/json",
    };
    const outcomes = [];
    for (const workspaceId of workspaceIds) {
      const opencode: { model: string; provider: Record<string, unknown>; small_model?: string; permission?: unknown } = {
        model: defaultModel,
        provider: {
          [providerId]: {
            npm: "@ai-sdk/openai-compatible",
            name: modelName,
            options: { baseURL: baseUrl, apiKey: "sk-eval-fixture" },
            models: { [modelId]: { name: modelName, tool_call: allowTools } },
          },
        },
      };
      if (smallModel) opencode.small_model = smallModel;
      if (allowTools) opencode.permission = { edit: "allow", write: "allow", read: "allow", bash: "allow" };
      const response = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/config", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ opencode }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        outcomes.push({ workspaceId, stage: "config", status: response.status, text: (await response.text()).slice(0, 300) });
        continue;
      }
      const reload = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(60000),
      });
      outcomes.push({ workspaceId, stage: "reload", status: reload.status, text: reload.ok ? "ok" : (await reload.text()).slice(0, 300) });
    }
    const raw = localStorage.getItem("openwork.preferences");
    let preferences: Record<string, unknown> = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: providerId, modelID: modelId },
      modelVariant: null,
      providerStepCleaned: true,
    }));
    localStorage.setItem("openwork.defaultModel", defaultModel);
    for (const workspaceId of workspaceIds) localStorage.removeItem("openwork.sessionModels." + workspaceId);
    return { outcomes };
  }, [
      [...workspaceIds],
      options.smallModel ?? null,
      options.allowTools ?? false,
      options.providerId,
      options.modelId,
      options.modelName,
      options.baseUrl,
      `${options.providerId}/${options.modelId}`,
    ]), { awaitPromise: true, timeoutMs: 240_000 });
  if (typeof result !== "object" || result === null || !("outcomes" in result) || !Array.isArray(result.outcomes)) {
    throw new Error(`Workspace provider configuration failed: ${JSON.stringify(result)}`);
  }
  const failures = result.outcomes.filter((outcome) => (
    typeof outcome !== "object" || outcome === null || !("status" in outcome) || outcome.status !== 200
  ));
  if (failures.length > 0) throw new Error(`Workspace provider configuration failed: ${JSON.stringify(failures)}`);
}

/** The app in headless Chrome by default; "electron" only for the native titlebar. */
async function oneWorkspace(seed: Seed, name: string, titles: readonly string[] = [], surface: "electron" | "web" = "web") {
  const workspacePath = seed.tmpPath(name);
  const app = surface === "electron" ? await seed.desktop({ name }) : await seed.appWeb({ name, workspacePath, mouse: true });
  const workspace = await seed.workspace(app, workspacePath);
  const sessions = titles.length > 0 ? await seed.sessions(app, titles) : [];
  return { app, workspace, workspacePath, sessions };
}

export async function sidebarOverflow(seed: Seed) {
  const longTitle = "Reading Google Drive documents for the quarterly workspace review";
  // Desktop: the journey also checks the macOS titlebar inset when the sidebar collapses.
  const app = await seed.desktop({ name: "sidebar-title-overflow-fade" });
  const workspacePath = "/tmp/Yonder";
  // The desktop already owns its default first-launch workspace; the title under test is this folder's name.
  const workspace = await seed.workspace(app, workspacePath, { create: true });
  const sessions = await seed.sessions(app, [longTitle]);
  return { app, workspace, workspacePath, sessions, longTitle };
}

export async function sidebarExpansion(seed: Seed, mode: "workspace" | "group" | "ungrouped") {
  const workspacePath = seed.tmpPath(`sidebar-${mode}`);
  const app = await seed.appWeb({ name: `sidebar-${mode}-expansion`, workspacePath, mouse: true });
  await app.client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 600, deviceScaleFactor: 1, mobile: false });
  const workspace = await seed.workspace(app, workspacePath);
  const sessions = await seed.sessions(app, Array.from({ length: 20 }, (_, index) => `Expansion task ${String(index + 1).padStart(2, "0")}`));
  const [neighbor] = await seed.sessions(app, ["Neighbor task"]);
  if (!neighbor) throw new Error("Sidebar expansion neighbor was not created");
  const groups = mode === "workspace" ? [] : [
    ...(mode === "group" ? [{ id: "grp_expansion", label: "Expansion group" }] : []),
    { id: "grp_neighbor", label: "Neighbor group" },
  ];
  const assignments = mode === "workspace" ? {} : Object.fromEntries([
    ...sessions.flatMap(session => mode === "group" ? [[session.sessionId, "grp_expansion"]] : []),
    [neighbor.sessionId, "grp_neighbor"],
  ]);
  // Persist real group state and manual order before reload; no component/store imports.
  await seed.evalIn(app, browserScript(async (workspaceId, groups, assignments, ids) => {
    const port = localStorage.getItem("openwork.server.port");
    if (!port) throw new Error("Sidebar seed needs the local server");
    const response = await fetch(`http://127.0.0.1:${port}/workspace/${encodeURIComponent(workspaceId)}/session-groups`, {
      method: "PUT", headers: { Authorization: `Bearer ${localStorage.getItem("openwork.server.token")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: { groups, assignments } }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Sidebar group seed failed: ${response.status}`);
    localStorage.setItem("openwork.react.sessionManagement", JSON.stringify({ state: {
      pinnedIds: [], unreadIds: [], orderByWorkspace: { [workspaceId]: ids },
      groupsByWorkspace: { [workspaceId]: { groups, assignments, collapsedGroupIds: [] } },
    }, version: 0 }));
  }, [workspace.workspaceId, groups, assignments, [...sessions.map(session => session.sessionId), neighbor.sessionId]]));
  await app.client.send("Page.reload");
  await waitFor(app, () => Boolean(document.querySelector('[data-sidebar-session-id]')) && Boolean(window.__openworkControl), {
    timeoutMs: 60_000, label: "sidebar expansion fixture reloaded",
  });
  const observation = await observeSidebarExpansion(app);
  return { app, workspace, sessions, neighbor, observation, [Symbol.asyncDispose]: () => observation[Symbol.asyncDispose]() };
}

export async function pinnedSessions(seed: Seed) {
  const workspacePath = seed.tmpPath("pinned-sessions-exposed");
  const app = await seed.appWeb({ name: "pinned-sessions-exposed", workspacePath, mouse: true });
  const workspace = await seed.workspace(app, workspacePath);
  const [candidate, neighbor] = await seed.sessions(app, ["Candidate session", "Neighbor session"]);
  if (!candidate || !neighbor) throw new Error("Pinned world did not create both sessions.");

  // TODO(primitive): probe.context should expose the OpenWork context snapshot.
  async function context(): Promise<{ pinnedSessionIds: string[]; pinnedResourceRefs: string[] }> {
    const value = await seed.evalIn(app, () => {
      const c = window.__openworkControl?.context?.();
      return {
        pinnedSessionIds: c?.conversations?.pinnedSessionIds ?? null,
        pinnedResourceRefs: (c?.resources ?? [])
          .filter((r) => r.kind === "session" && r.state?.pinned === true)
          .map((r) => r.ref),
      };
    });
    if (!isRecord(value)
      || !Array.isArray(value.pinnedSessionIds)
      || !value.pinnedSessionIds.every((id) => typeof id === "string")
      || !Array.isArray(value.pinnedResourceRefs)
      || !value.pinnedResourceRefs.every((ref) => typeof ref === "string")) {
      throw new Error(`OpenWork context pin state was malformed: ${JSON.stringify(value)}`);
    }
    return {
      pinnedSessionIds: value.pinnedSessionIds,
      pinnedResourceRefs: value.pinnedResourceRefs,
    };
  }

  // TODO(primitive): probe.sidebar complements user.see({ text: "Pinned" }) by exposing which rows the section contains.
  async function pinnedSidebarRows(): Promise<string[] | null> {
    const value = await seed.evalIn(app, () => {
      const section = document.querySelector<HTMLElement>("[data-global-pinned-sessions]");
      if (!section) return null;
      return [...section.querySelectorAll<HTMLElement>("[data-sidebar-session-id]")]
        .map((row) => row.getAttribute("data-sidebar-session-id"));
    });
    if (value === null) return null;
    if (!Array.isArray(value) || !value.every((sessionId) => typeof sessionId === "string")) {
      throw new Error(`Global pinned sidebar rows were malformed: ${JSON.stringify(value)}`);
    }
    return value;
  }

  return { app, workspace, workspacePath, candidate, neighbor, context, pinnedSidebarRows };
}

export async function commandPaletteSearch(seed: Seed) {
  const name = `command-palette-search-${Date.now()}`;
  const workspacePath = seed.tmpPath(name);
  const longModelId = "gwm_01m292tscteantqy79spgyvbcs_01m292tsbxehmvrpjxfn7m4n86_01m292tsbgey6s6q4hbnvd6a8h";
  const providerId = "palette-model-witness";
  const app = await seed.appWeb({ name, workspacePath, mouse: true });
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, longModelId, {
    model: `${providerId}/${longModelId}`,
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Palette model witness",
        options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "palette-model-fixture" },
        models: { [longModelId]: { name: longModelId } },
      },
    },
  });
  await waitFor(app, () => Boolean(window.__openworkControl), {
    timeoutMs: 60_000,
    label: "reloaded app-web command palette is interactive",
  });
  return {
    app,
    workspace,
    workspacePath,
    longModelId,
    location: () => seed.evalIn(app, () => window.location.pathname),
    runtimeFacts: () => seed.evalIn(app, () => ({
      browser: navigator.userAgent,
      electronBridge: Boolean(window.__OPENWORK_ELECTRON__),
    })),
  };
}

type ArchiveFault = "none" | "false" | "error" | "timeout" | "unconfirmed" | "hold" | "retry" | "permission" | "question" | "prompt_error" | "hold_prompt" | "accepted_command" | "accepted_prompt" | "hold_archive" | "hold_messages";
type ArchiveRequest = {
  path: string; sessionId: string; action: string; messageID: string | null; result: string | number | null;
  at: number; sequence: number; transport: "renderer" | "main";
  command?: { name: string; arguments: string; model: string | null; agent: string | null };
  responseBody?: string;
  dispatchError?: string;
  cancelled?: boolean;
};
type ArchiveControl = { action: "state" | "release" }
  | { action: "configure"; origin: string; workspaceIds: string[] }
  | { action: "fault"; mode: ArchiveFault; sessionId: string; workspaceId: string };
type ArchiveMainState = {
  witness: string; mode: ArchiveFault; sessionId: string; workspaceId: string;
  requests: ArchiveRequest[]; held: boolean; origin: string; workspaceIds: string[];
};

async function archiveMainControl(command: ArchiveControl): Promise<ArchiveMainState> {
  const response = await window.__OPENWORK_ELECTRON__.invokeDesktop("__fetch",
    "http://127.0.0.1/__openwork_archive_test_control", {
      method: "POST", body: JSON.stringify(command), timeoutMs: 25_000,
    });
  if (response.status !== 200) throw new Error("Archive main-fetch bootstrap is unavailable");
  const state: ArchiveMainState = JSON.parse(response.body);
  if (state.witness !== "archive-main-fetch-v1" || !Array.isArray(state.requests)
    || typeof state.held !== "boolean" || typeof state.origin !== "string" || !Array.isArray(state.workspaceIds)) {
    throw new Error("Archive main-fetch bootstrap returned malformed state");
  }
  return state;
}

declare global {
  interface Window {
    __archiveAvailabilityRequests: { method: string; path: string }[];
    __archiveNetwork: {
      mode: ArchiveFault;
      sessionId: string;
      workspaceId: string;
      requests: ArchiveRequest[];
      original: typeof fetch;
      release: (() => void | Promise<void>) | null;
    };
  }
}

export async function archiveActiveSessions(seed: Seed, { place }: { place: Place }) {
  if (resolveEvalEngine() !== "v1") throw new SkipError("Active archive requires v1; session-archive-undo covers v2 unavailability.");
  await using resources = new AsyncDisposableStack();
  const providerId = "session-archive-mock";
  const modelId = "mock-agent-workload-model";
  const remoteRoot = place.kind === "daytona" ? place.host()?.workspaceRoot : undefined;
  if (place.kind === "daytona" && !remoteRoot?.startsWith("/")) throw new Error("Archive main-fetch bootstrap requires the remote source checkout path");
  const preload = remoteRoot ? `${remoteRoot.replace(/\/+$/, "")}/evals/fixtures/archive-main-fetch.cjs`
    : fileURLToPath(new URL("../fixtures/archive-main-fetch.cjs", import.meta.url));
  const app = await seed.desktop({ name: "session-archive-button", model: `${providerId}/${modelId}`,
    env: { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(preload)}`].filter(Boolean).join(" ") },
  });
  const mainControl = (command: ArchiveControl) => seed.evalIn(app, browserScript(archiveMainControl, [command]), { timeoutMs: 30_000 });
  await mainControl({ action: "state" }).catch((error: unknown) => {
    throw new Error(`Archive main-fetch bootstrap was not installed from ${preload}`, { cause: error });
  });
  const definition = seed.mock({ agentWorkloads: [{ promptMarker: "session-archive", matchAll: true, finalReply: "Archive fixture reply.", steps: [] }] });
  const sandbox = app.handle.sandboxId;
  const booted = app.handle.hostKind === "daytona"
    ? await (async () => {
      if (!sandbox || !definition.connect) throw new Error("Archive mock requires its desktop sandbox and mock adapter.");
      const remote = await startMockOnSandbox({ sandbox, port: definition.daytonaPort });
      return definition.connect(remote.url);
    })()
    : await definition.boot(place);
  const mock = resources.use(booted.handle);
  const setHeld = async (held: boolean) => {
    const response = await fetch(`${mock.url}/admin/agent-hold`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ held }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Archive mock hold failed: HTTP ${response.status}`);
  };
  await setHeld(true);
  const stamp = `${Date.now()}-${process.pid}`;
  const workspaceA = await seed.workspace(app, `/tmp/openwork-session-archive-${stamp}-a`);
  const workspaceBName = `openwork-session-archive-${stamp}-b`;
  const workspaceB = await additionalWorkspace(seed, app, `/tmp/${workspaceBName}`);
  await configureWorkspaceProvider(seed, app, [workspaceA.workspaceId, workspaceB.workspaceId], {
    providerId, modelId, modelName: "Archive fixture model", baseUrl: `${mock.url}/v1`, allowTools: true,
  });
  // OpenWork's runtime config drops command/model keys. In v1.18.18 the native
  // workspace PATCH also writes config.json, which its project loader ignores.
  // Use the native global config in this desktop's isolated profile instead.
  const commandSetup = await seed.evalIn(app, browserScript(async (workspaceId, model) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.running || !info.baseUrl) throw new Error("Archive engine is unavailable");
    const base = `${info.baseUrl.replace(/\/+$/, "")}/workspace/${workspaceId}/opencode`;
    const headers = { Authorization: "Bearer " + (info.ownerToken ?? info.clientToken), "Content-Type": "application/json" };
    const read = async () => {
      const [configResponse, commandsResponse] = await Promise.all(["config", "command"].map(endpoint =>
        fetch(`${base}/${endpoint}`, { headers, signal: AbortSignal.timeout(15000) })));
      if (!configResponse.ok || !commandsResponse.ok) throw new Error(`Archive command inventory failed: config=${configResponse.status}, commands=${commandsResponse.status}`);
      const config: { model?: string; small_model?: string; default_agent?: string } = await configResponse.json();
      const commands: { name: string; template: string; model?: string; agent?: string }[] = await commandsResponse.json();
      const command = commands.find(command => command.name === "archive-witness");
      return { model: config.model ?? null, smallModel: config.small_model ?? null, agent: config.default_agent ?? null,
        command: command ? { name: command.name, template: command.template, model: command.model ?? null, agent: command.agent ?? null } : null,
        commandNames: commands.map(command => command.name).sort() };
    };
    const before = await read();
    const response = await fetch(`${base}/global/config`, {
      method: "PATCH", headers, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ model, small_model: model, command: { "archive-witness": { template: "Archive command witness task." } } }),
    });
    if (!response.ok) throw new Error(`Archive native command configuration failed: ${response.status} ${(await response.text()).slice(0, 2000)}`);
    // Global config invalidates instances asynchronously; observe actual engine
    // readiness before creating sessions or submitting any held command.
    const deadline = Date.now() + 30_000;
    let after = await read();
    while (after.model !== model || after.smallModel !== model || after.command?.template !== "Archive command witness task.") {
      if (Date.now() >= deadline) throw new Error(`Archive command is not ready: ${JSON.stringify({ after, before })}`);
      await new Promise(resolve => setTimeout(resolve, 250));
      after = await read();
    }
    return { before, after };
  }, [workspaceA.workspaceId, `${providerId}/${modelId}`]), { timeoutMs: 90_000 });
  // Seed each owning engine once; UI task creation can race route changes and create extra sessions.
  async function createSession(workspaceId: string, title: string, parentID?: string): Promise<ShellSession & { workspaceId: string }> {
    const result = await seed.evalIn(app, browserScript(async (workspaceId, title, parentID) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      if (!info.running || !info.baseUrl) throw new Error("Archive engine is unavailable");
      const response = await fetch(info.baseUrl.replace(/\/+$/, "") + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode/session", {
        method: "POST", headers: { Authorization: "Bearer " + (info.ownerToken ?? info.clientToken), "Content-Type": "application/json" },
        body: JSON.stringify(parentID ? { title, parentID } : { title }), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Could not seed " + title + " in " + workspaceId + ": " + response.status);
      const session = await response.json();
      return { sessionId: session.id, title: session.title };
    }, [workspaceId, title, parentID]), { timeoutMs: 20_000 });
    if (!isRecord(result) || typeof result.sessionId !== "string" || !result.sessionId || typeof result.title !== "string") {
      throw new Error(`Missing archive session ${title}: ${JSON.stringify(result)}`);
    }
    return { sessionId: result.sessionId, title: result.title, workspaceId };
  }
  const a1 = await createSession(workspaceA.workspaceId, "Chat A");
  const a2 = await createSession(workspaceA.workspaceId, "Archive idle neighbor");
  const b1 = await createSession(workspaceB.workspaceId, "Archive other workspace");
  const child = await createSession(workspaceA.workspaceId, "Archive child task", a1.sessionId);
  // Never reuse synthetic retry/approval state as a real-run target.
  const faultCandidate = await createSession(workspaceA.workspaceId, "Archive fault isolation");

  const previousTimeOrigin = await seed.evalIn(app, () => performance.timeOrigin);
  if (typeof previousTimeOrigin !== "number") throw new Error("Archive document time origin was unavailable.");
  await seed.evalIn(app, browserScript((workspaceId) => {
    history.replaceState(history.state, "", "#/workspace/" + encodeURIComponent(workspaceId) + "/session");
    location.reload();
    return true;
  }, [workspaceB.workspaceId]));
  // Expansion is not persisted: let B render after reload, then leave both groups open on A's start route.
  for (const phase of [
    { workspaceId: workspaceB.workspaceId, sessions: [b1] },
    { workspaceId: workspaceA.workspaceId, sessions: [a1, a2, b1, faultCandidate] },
  ]) {
    if (phase.workspaceId === workspaceA.workspaceId) {
      await seed.evalIn(app, browserScript((workspaceId) => {
        location.hash = "/workspace/" + encodeURIComponent(workspaceId) + "/session";
        return true;
      }, [workspaceA.workspaceId]));
    }
    const deadline = Date.now() + 60_000;
    let ready = false;
    let lastState: unknown = null;
    while (Date.now() < deadline) {
      lastState = await seed.evalIn(app, browserScript((previousTimeOrigin, workspaceId, sessions) => {
        const route = window.__openwork?.slice?.("route");
        const rows = sessions.map((session) => {
          const row = document.querySelector('[data-sidebar-workspace-id="' + session.workspaceId + '"] [data-sidebar-session-id="' + session.sessionId + '"]');
          return {
            sessionId: session.sessionId,
            loaded: route?.sessionsByWorkspaceId?.[session.workspaceId]?.some(item => item.id === session.sessionId) === true,
            visible: Boolean(row?.getClientRects().length),
          };
        });
        return {
          hash: location.hash, selectedWorkspaceId: route?.selectedWorkspaceId, rows,
          ready: performance.timeOrigin !== previousTimeOrigin && Boolean(window.__openworkControl)
            && route?.selectedWorkspaceId === workspaceId
            && !route.workspaces.find(workspace => workspace.id === workspaceId)?.loading
            && location.hash === "#/workspace/" + encodeURIComponent(workspaceId) + "/session"
            && rows.every(row => row.loaded && row.visible),
        };
      }, [previousTimeOrigin, phase.workspaceId, phase.sessions]), {
        timeoutMs: Math.min(5_000, Math.max(1, deadline - Date.now())),
      }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      if (isRecord(lastState) && lastState.ready === true) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
    }
    if (!ready) throw new Error(`Archive workspace ${phase.workspaceId} route and sidebar did not become ready: ${JSON.stringify(lastState)}`);
  }

  const upstreamOrigin = await seed.evalIn(app, async () => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.running || !info.baseUrl) throw new Error("Archive engine is unavailable");
    return new URL(info.baseUrl).origin;
  });
  await mainControl({ action: "configure", origin: upstreamOrigin, workspaceIds: [workspaceA.workspaceId, workspaceB.workspaceId] });
  await seed.evalIn(app, browserScript((origin, workspaceIds) => {
    const original = window.fetch.bind(window);
    const state: Window["__archiveNetwork"] = { mode: "none", sessionId: "", workspaceId: "", requests: [], release: null, original };
    window.__archiveNetwork = state;
    let sequence = 0;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const mount = url.pathname.match(/^\/(?:workspace|w)\/([^/]+)\/opencode\//);
      if (url.origin !== origin || !mount || !workspaceIds.includes(decodeURIComponent(mount[1]))) return original(request);
      const stamp: Pick<ArchiveRequest, "at" | "sequence" | "transport"> = { at: Date.now(), sequence: sequence++, transport: "renderer" };
      const match = url.pathname.match(/\/session\/([^/]+)\/(abort|prompt_async|command|shell)$/);
      const metadata = request.method === "PATCH" ? url.pathname.match(/\/session\/([^/]+)$/) : null;
      const messages = request.method === "GET" && state.mode === "hold_messages"
        ? url.pathname.match(/\/session\/([^/]+)\/message$/) : null;
      const record: ArchiveRequest | null = match && request.method === "POST"
        ? { ...stamp, path: url.pathname, sessionId: match[1], action: match[2], messageID: null, result: null }
        : metadata ? { ...stamp, path: url.pathname, sessionId: metadata[1], action: "metadata", messageID: null, result: null }
        : messages ? { ...stamp, path: url.pathname, sessionId: messages[1], action: "messages", messageID: null, result: null } : null;
      if (record && ["prompt_async", "command"].includes(record.action)) {
        const body: unknown = await request.clone().json();
        if (body && typeof body === "object" && "messageID" in body && typeof body.messageID === "string") record.messageID = body.messageID;
        if (record.action === "command" && body && typeof body === "object" && "command" in body && typeof body.command === "string"
          && "arguments" in body && typeof body.arguments === "string") {
          record.command = { name: body.command, arguments: body.arguments,
            model: "model" in body && typeof body.model === "string" ? body.model : null,
            agent: "agent" in body && typeof body.agent === "string" ? body.agent : null };
        }
      }
      if (record) state.requests.push(record);
      const owner = decodeURIComponent(mount[1]) === state.workspaceId;
      const target = owner && record?.sessionId === state.sessionId;
      if (record?.action === "metadata" && target && state.mode === "hold_archive") {
        await new Promise<void>(resolve => { state.release = resolve; });
        state.release = null;
      }
      if (record && target && (
        (record.action === "command" && state.mode === "accepted_command")
        || (record.action === "prompt_async" && state.mode === "accepted_prompt")
      )) {
        record.result = "accepted, not dispatched";
        const admitted = new Request(request, { signal: new AbortController().signal });
        state.release = async () => {
          state.release = null;
          try {
            const response = await original(admitted);
            record.result = response.status;
            record.responseBody = (await response.text()).slice(0, 2000);
            if (!response.ok) throw new Error("Admitted " + record.action + " dispatch failed: " + response.status + " " + record.responseBody);
          } catch (error) {
            record.dispatchError = error instanceof Error ? error.message : String(error);
            throw error;
          }
        };
        return record.action === "prompt_async" ? new Response(null, { status: 204 }) : Response.json({ ok: true, accepted: true });
      }
      if (record?.action === "prompt_async" && target && state.mode === "prompt_error") {
        record.result = 400;
        return Response.json({ error: "Injected send failure" }, { status: 400 });
      }
      if (record?.action === "prompt_async" && target && state.mode === "hold_prompt") {
        await new Promise<void>(resolve => { state.release = resolve; });
        state.release = null;
        record.result = 400;
        return Response.json({ error: "Injected delayed queue send failure" }, { status: 400 });
      }
      if (record?.action === "abort" && target && ["false", "error", "timeout", "unconfirmed", "hold"].includes(state.mode)) {
        const mode = state.mode;
        if (mode === "hold" || mode === "timeout") {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { state.release = null; record.result = "cancelled"; reject(request.signal.reason); };
            state.release = () => {
              request.signal.removeEventListener("abort", abort);
              state.release = null;
              if (state.mode === "hold") state.mode = "none";
              resolve();
            };
            if (request.signal.aborted) abort();
            else request.signal.addEventListener("abort", abort, { once: true });
          });
        } else {
          record.result = mode;
          if (mode === "error") throw new TypeError("Injected abort connection failure");
          return Response.json(mode === "unconfirmed");
        }
      }
      const response = await original(request);
      if (record) record.result = response.status;
      if (record?.action === "messages" && target && state.mode === "hold_messages" && response.ok) {
        const body = new Uint8Array(await response.arrayBuffer());
        const previousRelease = state.release;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            record.result = "held";
            const finish = (expired: boolean) => {
              if (record.result !== "held") return;
              clearTimeout(timer);
              record.result = expired ? "expired" : "released";
              state.release = null;
              controller.enqueue(body);
              controller.close();
            };
            const timer = setTimeout(() => finish(true), 20_000);
            state.release = async () => { await previousRelease?.(); finish(false); };
          },
        });
        return new Response(stream, { status: response.status, headers: response.headers });
      }
      // Merge only the owning endpoint's target. All unrelated statuses and
      // approvals remain authoritative, including concurrently running sessions.
      const { mode, sessionId, workspaceId } = state;
      const owningResponse = decodeURIComponent(mount[1]) === workspaceId;
      const stillArmed = () => state.mode === mode && state.sessionId === sessionId && state.workspaceId === workspaceId;
      if (owningResponse && response.ok && mode === "retry" && url.pathname.endsWith("/session/status")) {
        const statuses: Record<string, unknown> = await response.clone().json();
        if (!stillArmed()) return response;
        return Response.json({ ...statuses, [sessionId]: { type: "retry", attempt: 1, message: "Retrying", next: Date.now() + 60000 } });
      }
      if (owningResponse && response.ok && (mode === "permission" || mode === "question") && url.pathname.endsWith("/opencode/" + mode)) {
        const requests: unknown[] = await response.clone().json();
        if (!stillArmed()) return response;
        return Response.json([...requests, { id: "archive-pending-request", sessionID: sessionId,
          permission: "bash", patterns: ["*"], metadata: {}, always: [],
          questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }] }],
        }]);
      }
      return response;
    };
    return true;
  }, [upstreamOrigin, [workspaceA.workspaceId, workspaceB.workspaceId]]));

  async function networkFault(mode: ArchiveFault, sessionId: string) {
    const target = [a1, a2, b1, child, faultCandidate].find(session => session.sessionId === sessionId);
    if (!target) throw new Error("Archive fault target has no known workspace owner");
    if ((await mainControl({ action: "state" })).held) throw new Error("Release the previous main archive fault before replacing it");
    await seed.evalIn(app, browserScript((mode, sessionId, workspaceId) => {
      if (window.__archiveNetwork.release) throw new Error("Release the previous archive fault before replacing it");
      window.__archiveNetwork.mode = mode;
      window.__archiveNetwork.sessionId = sessionId;
      window.__archiveNetwork.workspaceId = workspaceId;
      return true;
    }, [mode, sessionId, target.workspaceId]));
    await mainControl({ action: "fault", mode, sessionId, workspaceId: target.workspaceId });
  }

  const requestLedger = new Map<string, ArchiveRequest>();
  function mergeRequests(renderer: unknown[], main: ArchiveRequest[]) {
    const entries = [...renderer, ...main].map((entry) => {
      if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.sessionId !== "string"
        || typeof entry.action !== "string" || typeof entry.at !== "number" || typeof entry.sequence !== "number"
        || (entry.transport !== "renderer" && entry.transport !== "main")
        || !(entry.messageID === null || typeof entry.messageID === "string")
        || !(entry.result === null || typeof entry.result === "string" || typeof entry.result === "number")) {
        throw new Error("Malformed archive request ledger");
      }
      let command: ArchiveRequest["command"];
      if (entry.command !== undefined) {
        const value = entry.command;
        if (!isRecord(value) || typeof value.name !== "string" || typeof value.arguments !== "string"
          || !(value.model === null || typeof value.model === "string") || !(value.agent === null || typeof value.agent === "string")) {
          throw new Error("Malformed archive command request");
        }
        command = { name: value.name, arguments: value.arguments, model: value.model, agent: value.agent };
      }
      const record: ArchiveRequest = {
        path: entry.path, sessionId: entry.sessionId, action: entry.action, result: entry.result, messageID: entry.messageID,
        at: entry.at, sequence: entry.sequence, transport: entry.transport,
        ...(command === undefined ? {} : { command: { name: command.name, arguments: command.arguments, model: command.model, agent: command.agent } }),
        ...(typeof entry.responseBody === "string" ? { responseBody: entry.responseBody } : {}),
        ...(typeof entry.dispatchError === "string" ? { dispatchError: entry.dispatchError } : {}),
        ...(typeof entry.cancelled === "boolean" ? { cancelled: entry.cancelled } : {}),
      };
      return record;
    }).sort((left, right) => left.at - right.at || left.transport.localeCompare(right.transport) || left.sequence - right.sequence);
    for (const entry of entries) requestLedger.set(`${entry.transport}:${entry.sequence}`, entry);
    return [...requestLedger.values()];
  }

  async function facts() {
    const result = await seed.evalIn(app, browserScript(async (workspaceIds) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      if (!info.running || !info.baseUrl) throw new Error("Archive engine is unavailable");
      const headers = { Authorization: "Bearer " + (info.ownerToken ?? info.clientToken) };
      const sessions = [];
      // Assertions use real engine facts, never our injected fault response.
      const read = window.__archiveNetwork.original;
      for (const workspaceId of workspaceIds) {
        const base = info.baseUrl.replace(/\/+$/, "") + "/workspace/" + workspaceId + "/opencode";
        const [list, statuses] = await Promise.all([
          read(base + "/session?limit=200", { headers, signal: AbortSignal.timeout(10000) }).then(r => { if (!r.ok) throw new Error("Session list: " + r.status); return r.json(); }),
          read(base + "/session/status", { headers, signal: AbortSignal.timeout(10000) }).then(r => { if (!r.ok) throw new Error("Session status: " + r.status); return r.json(); }),
        ]);
        for (const session of list) sessions.push({ workspaceId, sessionId: session.id,
          archived: (session.time?.archived ?? 0) > 0, status: statuses[session.id]?.type ?? "idle" });
      }
      return {
        sessions,
        requests: window.__archiveNetwork.requests,
        surfaces: [...document.querySelectorAll("[data-session-surface-id]")].map(el => el.getAttribute("data-session-surface-id")),
        activeRows: [...document.querySelectorAll("[data-sidebar-workspace-id] [data-sidebar-session-id]")].map(el => el.getAttribute("data-sidebar-session-id")),
        tabs: window.__openworkControl.context().conversations.tabs.map(tab => tab.sessionId),
        memory: JSON.parse(localStorage.getItem("openwork.react.sessionByWorkspace") ?? "{}"),
      };
    }, [[workspaceA.workspaceId, workspaceB.workspaceId]]), { timeoutMs: 30_000 });
    if (!isRecord(result) || !Array.isArray(result.sessions) || !Array.isArray(result.requests)
      || !Array.isArray(result.surfaces) || !Array.isArray(result.activeRows) || !Array.isArray(result.tabs) || !isRecord(result.memory)) {
      throw new Error(`Malformed archive facts: ${JSON.stringify(result)}`);
    }
    const sessions = result.sessions.map((entry) => {
      if (!isRecord(entry) || typeof entry.workspaceId !== "string" || typeof entry.sessionId !== "string"
        || typeof entry.archived !== "boolean" || typeof entry.status !== "string") throw new Error("Malformed archive session");
      return { workspaceId: entry.workspaceId, sessionId: entry.sessionId, archived: entry.archived, status: entry.status };
    });
    const requests = mergeRequests(result.requests, (await mainControl({ action: "state" })).requests);
    return { sessions, requests, surfaces: result.surfaces, activeRows: result.activeRows, tabs: result.tabs, memory: result.memory };
  }

  const paletteShortcut = await seed.evalIn(app, () => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta+K" : "Control+K");
  const lifetime = resources.move();
  return {
    app,
    workspaceA,
    workspaceB,
    a1,
    a2,
    b1,
    child,
    faultCandidate,
    workspaceBName,
    commandSetup,
    paletteShortcut,
    facts,
    mainRequests: async () => (await mainControl({ action: "state" })).requests,
    archiveAccessibleDescription: async () => {
      const tree = await app.client.send("Accessibility.getFullAXTree");
      if (!isRecord(tree) || !Array.isArray(tree.nodes)) throw new Error("Archive accessibility tree is unavailable");
      const dialog = tree.nodes.find(node => isRecord(node) && isRecord(node.role) && node.role.value === "alertdialog" && node.ignored !== true);
      if (!isRecord(dialog) || !isRecord(dialog.description) || typeof dialog.description.value !== "string") {
        throw new Error("Archive dialog has no computed accessible description");
      }
      return dialog.description.value;
    },
    archiveConfirmation: () => seed.evalIn(app, () => {
      const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
      const title = dialog?.querySelector<HTMLElement>('[data-slot="alert-dialog-title"]');
      const bounds = dialog?.getBoundingClientRect();
      return {
        title: title?.textContent,
        text: dialog?.innerText,
        metadata: [...(dialog?.querySelectorAll("dl > div") ?? [])].map(row => ({
          label: row.querySelector("dt")?.textContent,
          value: row.querySelector("dd")?.textContent,
          selectable: getComputedStyle(row.querySelector("dd") ?? row).userSelect === "text",
        })),
        titleUnclipped: Boolean(title && title.scrollWidth <= title.clientWidth && title.scrollHeight <= title.clientHeight
          && getComputedStyle(title).textOverflow !== "ellipsis" && getComputedStyle(title).webkitLineClamp === "none"),
        fitsViewport: Boolean(bounds && bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight),
        noHorizontalOverflow: Boolean(dialog && dialog.scrollWidth <= dialog.clientWidth),
        contentReachable: Boolean(dialog && (dialog.scrollHeight <= dialog.clientHeight || getComputedStyle(dialog).overflowY === "auto")),
      };
    }),
    resize: (width: number, height: number) => app.client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }),
    networkFault,
    faultObservation: () => seed.evalIn(app, browserScript(async (workspaceIds) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      if (!info.running || !info.baseUrl) throw new Error("Archive engine is unavailable");
      const root = info.baseUrl.replace(/\/+$/, "");
      const results = [];
      for (const workspaceId of workspaceIds) {
        for (const endpoint of ["session/status", "permission", "question"]) {
          const url = `${root}/workspace/${workspaceId}/opencode/${endpoint}`;
          const options = { headers: { Authorization: "Bearer " + (info.ownerToken ?? info.clientToken) }, signal: AbortSignal.timeout(10000) };
          const [actual, observed, main] = await Promise.all([
            window.__archiveNetwork.original(url, options), fetch(url, options),
            window.__OPENWORK_ELECTRON__.invokeDesktop("__fetch", url, { method: "GET", headers: options.headers, timeoutMs: 10000 }),
          ]);
          if (!actual.ok || !observed.ok || main.status < 200 || main.status >= 300) throw new Error(`Fault observation failed for ${endpoint}`);
          const actualBody = await actual.json();
          results.push({ workspaceId, endpoint, transport: "renderer", actual: actualBody, observed: await observed.json() });
          results.push({ workspaceId, endpoint, transport: "main", actual: actualBody, observed: JSON.parse(main.body) });
        }
      }
      return results;
    }, [[workspaceA.workspaceId, workspaceB.workspaceId]]), { timeoutMs: 30_000 }),
    diagnostics: async () => {
      const renderer = await seed.evalIn(app, () => ({
        hash: location.hash,
        fault: { mode: window.__archiveNetwork.mode, sessionId: window.__archiveNetwork.sessionId, workspaceId: window.__archiveNetwork.workspaceId, held: window.__archiveNetwork.release !== null },
        composer: window.__openwork?.slice("composer"),
        events: window.__openwork?.events(80),
        drafts: localStorage.getItem("openwork.session-drafts.v2"),
        surfaces: [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")].map(surface => ({
          sessionId: surface.dataset.sessionSurfaceId,
          text: surface.innerText.slice(-6000),
          draft: surface.querySelector<HTMLElement>('[data-lexical-editor="true"]')?.innerText,
        })),
        actions: window.__openworkControl.listActions().filter(action => action.id.startsWith("composer.")).map(action => ({ id: action.id, disabled: action.disabled })),
        requests: window.__archiveNetwork.requests,
      }));
      const main = await mainControl({ action: "state" });
      return { ...renderer, fault: { ...renderer.fault, held: renderer.fault.held || main.held },
        mainFault: { mode: main.mode, sessionId: main.sessionId, workspaceId: main.workspaceId, held: main.held },
        requests: mergeRequests(renderer.requests, main.requests) };
    },
    surfaceReady: (sessionId: string) => seed.evalIn(app, browserScript((sessionId) => {
      const surface = document.querySelector<HTMLElement>(`[data-session-surface-id="${sessionId}"]`);
      const snapshot = window.__openwork?.slice("composer")?.snapshotQuery;
      return Boolean(surface?.getClientRects().length && surface.querySelector('[data-lexical-editor="true"][contenteditable="true"]'))
        && snapshot?.intendedSessionId === sessionId && snapshot.currentSnapshotId === sessionId;
    }, [sessionId])),
    undoToastSettled: () => seed.evalIn(app, () => {
      const toast = document.querySelector("[data-undo-toast]")?.closest("[data-sonner-toast]");
      return toast instanceof HTMLElement && toast.dataset.mounted === "true"
        && toast.getAnimations({ subtree: true }).every(animation => animation.playState !== "running");
    }),
    dispatchUnrelatedPrompt: (session: { workspaceId: string; sessionId: string }) => seed.evalIn(app, browserScript(async (session, providerID, modelID) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      if (!info.running || !info.baseUrl) throw new Error("Archive engine is unavailable");
      const response = await fetch(`${info.baseUrl.replace(/\/+$/, "")}/workspace/${session.workspaceId}/opencode/session/${session.sessionId}/prompt_async`, {
        method: "POST", headers: { Authorization: "Bearer " + (info.ownerToken ?? info.clientToken), "Content-Type": "application/json" },
        body: JSON.stringify({ model: { providerID, modelID }, parts: [{ type: "text", text: "An independently submitted task, not the accepted command." }] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Independent prompt rejected: " + response.status);
      return true;
    }, [session, providerId, modelId]), { timeoutMs: 20_000 }),
    releaseAbort: async () => {
      const main = await mainControl({ action: "state" });
      const rendererHeld = await seed.evalIn(app, () => window.__archiveNetwork.release !== null);
      if (!main.held && !rendererHeld) throw new Error("No pending archive request to release");
      if (main.held) await mainControl({ action: "release" });
      if (rendererHeld) await seed.evalIn(app, async () => {
        if (!window.__archiveNetwork.release) throw new Error("Renderer archive request was cancelled before release");
        await window.__archiveNetwork.release();
        return true;
      }, { timeoutMs: 30_000 });
      if (main.mode === "hold") await networkFault("none", main.sessionId);
      return true;
    },
    requests: async () => (await mock.agentRequests()).filter(request => request.kind !== "utility"),
    releaseRun: () => setHeld(false),
    holdRun: () => setHeld(true),
    transcript: (session: { workspaceId: string; sessionId: string }) => seed.evalIn(app, browserScript(async (workspaceId, sessionId) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      if (!info.running || !info.baseUrl) throw new Error("Archive engine is unavailable");
      const response = await window.__archiveNetwork.original(info.baseUrl.replace(/\/+$/, "") + "/workspace/" + workspaceId + "/opencode/session/" + sessionId + "/message", {
        headers: { Authorization: "Bearer " + (info.ownerToken ?? info.clientToken) }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Could not read transcript: " + response.status);
      const messages: { info: { id: string; sessionID: string; role: string; parentID?: string; time: { completed?: number }; finish?: string; error?: unknown }; parts: { type: string; text?: string; state?: { status: string } }[] }[] = await response.json();
      return messages.map(({ info, parts }) => ({ id: info.id, sessionId: info.sessionID, role: info.role, parentID: info.parentID ?? null,
        completed: info.time.completed ?? null, finish: info.finish ?? null, error: info.error ?? null,
        pendingTools: parts.some(p => p.type === "tool" && (p.state?.status === "pending" || p.state?.status === "running")),
        text: parts.filter(p => p.type === "text").map(p => p.text).join("\n") }));
    }, [session.workspaceId, session.sessionId]), { timeoutMs: 20_000 }),
    async [Symbol.asyncDispose]() { await lifetime.disposeAsync(); },
  };
}

/** Two sessions ready to archive, on the desktop: session-archive-undo asserts the native context menu. */
export async function archiveSessions(seed: Seed) {
  return archiveSessionsOn(seed, "electron");
}

/** Two sessions ready to archive, on the app in headless Chrome. */
export async function archiveSessionsWeb(seed: Seed) {
  return archiveSessionsOn(seed, "web");
}

async function archiveSessionsOn(seed: Seed, surface: "electron" | "web") {
  const workspacePath = seed.tmpPath("session-archive-undo");
  const app = surface === "electron"
    ? await seed.desktop({ name: "session-archive-undo" })
    : await seed.appWeb({ name: "session-archive", workspacePath, mouse: true });
  return archiveWorld(seed, app, workspacePath, ["Archive candidate", "Archive neighbor"]);
}

/**
 * Archive in a workspace the desktop stores by a linked path. The folder does
 * not exist when the workspace is added, so the desktop keeps the path as
 * given (`<root>/link/OpenWork Chat`) while the engine resolves it and stamps
 * every session with the real path (`<root>/real/OpenWork Chat`) — the shape a
 * fresh macOS profile has under `/var` -> `/private/var`.
 */
export async function archiveSessionsInLinkedWorkspace(seed: Seed) {
  if (resolveEvalEngine() !== "v1") throw new SkipError("Archive is unavailable in the v2 preview; session-archive-undo covers that.");
  const app = await seed.desktop({ name: "session-archive-linked-path" });
  const root = seed.tmpPath("session-archive-linked");
  const real = `${root}/real`;
  const link = `${root}/link`;
  // The real parent as the app host resolves it; `seed.tmpPath` itself may sit behind a symlink (macOS /tmp).
  let resolvedReal: string;
  if (app.handle.sandboxId) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const script = `mkdir -p ${quote(real)} && ln -sfn ${quote(real)} ${quote(link)} && readlink -f ${quote(real)}`;
    const result = await execInSandbox(defaultDaytonaExec, app.handle.sandboxId, `printf %s ${Buffer.from(script).toString("base64")} | base64 -d | bash`, { timeoutMs: 15_000, context: "Arrange the linked workspace parent" });
    resolvedReal = result.stdout.trim();
    if (result.code !== 0 || !resolvedReal.startsWith("/")) throw new Error(`Linked workspace parent arrangement failed: ${result.stderr || result.stdout}`);
  } else {
    await mkdir(real, { recursive: true });
    await symlink(real, link);
    resolvedReal = await realpath(real);
  }
  const world = await archiveWorld(seed, app, `${link}/OpenWork Chat`, ["Split pane conversation", "Other pane"], { create: true });
  return {
    ...world,
    realWorkspacePath: `${resolvedReal}/OpenWork Chat`,
    /** The path the desktop persisted for the workspace, exactly as it will address the engine. */
    storedWorkspacePath: async () => {
      const value = await seed.evalIn(app, browserScript((workspaceId) =>
        window.__openwork?.slice?.("route")?.workspaces?.find(item => item.id === workspaceId)?.path ?? null, [world.workspace.workspaceId]));
      if (typeof value !== "string") throw new Error(`Stored workspace path was malformed: ${JSON.stringify(value)}`);
      return value;
    },
    /** The directory the engine stamped on each session, read through the workspace mount. */
    engineDirectories: async (): Promise<Record<string, string>> => {
      const value = await seed.evalIn(app, browserScript(async (workspaceId) => {
        const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
        if (!info?.running || !info.baseUrl) throw new Error("OpenWork server is unavailable");
        const response = await fetch(`${String(info.baseUrl).replace(/\/+$/, "")}/workspace/${encodeURIComponent(workspaceId)}/opencode/session?limit=200`, {
          headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") }, signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error("Workspace session listing failed with HTTP " + response.status);
        const sessions = await response.json();
        if (!Array.isArray(sessions)) throw new Error("Workspace session listing was not an array");
        return Object.fromEntries(sessions.filter((session) => typeof session?.id === "string" && typeof session?.directory === "string")
          .map((session) => [session.id, session.directory]));
      }, [world.workspace.workspaceId]), { awaitPromise: true, timeoutMs: 20_000 });
      if (!isRecord(value) || !Object.values(value).every((directory) => typeof directory === "string")) {
        throw new Error(`Engine directories were malformed: ${JSON.stringify(value)}`);
      }
      return Object.fromEntries(Object.entries(value).map(([id, directory]) => [id, String(directory)]));
    },
    splitFacts: () => seed.evalIn(app, () => {
      const layout = window.__openworkControl?.context?.()?.conversations?.layout;
      return {
        primarySessionId: (layout?.kind === "split" ? layout.primarySessionId : undefined) ?? (layout?.kind === "single" ? layout.sessionId : undefined) ?? "",
        secondarySessionId: (layout?.kind === "split" ? layout.secondarySessionId : undefined) ?? "",
        secondaryPaneCount: document.querySelectorAll('[data-workbench-pane="secondary"]').length,
      };
    }),
  };
}

async function archiveWorld(seed: Seed, app: Surface, workspacePath: string, titles: [string, string], options: { create?: boolean } = {}) {
  const engine = resolveEvalEngine();
  const workspace = await seed.workspace(app, workspacePath, options);
  const [candidate, neighbor] = await seed.sessions(app, titles);
  if (!candidate || !neighbor) throw new Error("Archive world did not create both sessions.");
  await seed.evalIn(app, browserScript((workspaceId) => {
    const original = window.fetch.bind(window);
    window.__archiveAvailabilityRequests = [];
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.startsWith(`/workspace/${workspaceId}/`)
        && ((request.method === "POST" && /\/(abort|interrupt)$/.test(path)) || (request.method === "PATCH" && /\/session\/[^/]+$/.test(path)))) {
        window.__archiveAvailabilityRequests.push({ method: request.method, path });
      }
      return original(request);
    };
    return true;
  }, [workspace.workspaceId]));

  /**
   * OpenCode's own `time.archived` stamp per session id (0 when active), read
   * through the workspace-scoped OpenWork server mount the desktop uses.
   */
  // TODO(primitive): probe.sessions should expose the workspace's native session list.
  async function archivedAt(): Promise<Record<string, number>> {
    const value = await seed.evalIn(app, browserScript(async (workspaceId, engine) => {
      // Desktop bridge first; the app in a browser keeps the address in localStorage.
      const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
      const port = localStorage.getItem("openwork.server.port");
      const baseUrl = info?.running && info.baseUrl ? String(info.baseUrl) : port ? "http://127.0.0.1:" + port : "";
      const token = info?.running && info.baseUrl ? String(info.ownerToken ?? info.clientToken ?? "") : localStorage.getItem("openwork.server.token") ?? "";
      if (!baseUrl) throw new Error("OpenWork server is unavailable");
      const response = await fetch(
        baseUrl.replace(/\/+$/, "") + "/workspace/" + encodeURIComponent(workspaceId) + (engine === "v2" ? "/opencode2/api/session?limit=200" : "/opencode/session?limit=200"),
        {
          headers: { Authorization: "Bearer " + token },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) throw new Error("Workspace session listing failed with HTTP " + response.status);
      const body = await response.json();
      const sessions = engine === "v2" ? body.data : body;
      if (!Array.isArray(sessions)) throw new Error("Workspace session listing was not an array");
      return Object.fromEntries(sessions
        .filter((session) => typeof session?.id === "string")
        .map((session) => [session.id, typeof session?.time?.archived === "number" ? session.time.archived : 0]));
    }, [workspace.workspaceId, engine]), { awaitPromise: true, timeoutMs: 20_000 });
    if (!isRecord(value)) throw new Error(`Workspace archived state was malformed: ${JSON.stringify(value)}`);
    const stamps: Record<string, number> = {};
    for (const [sessionId, stamp] of Object.entries(value)) {
      if (typeof stamp !== "number") throw new Error(`Archived stamp for ${sessionId} was malformed: ${JSON.stringify(stamp)}`);
      stamps[sessionId] = stamp;
    }
    return stamps;
  }

  /** Active rows, the global Archived section, and the candidate's own archive button. */
  // TODO(primitive): probe.sidebar should expose the workspace tree and the Archived section.
  async function sidebar(): Promise<{ active: string[]; archivedSection: boolean; archiveButtonDisabled: boolean | null; archiveButtonTitle: string | null }> {
    const value = await seed.evalIn(app, browserScript((workspaceId, candidateId) => {
      const tree = document.querySelector<HTMLElement>('[data-sidebar-workspace-id="' + workspaceId + '"]');
      const button = tree?.querySelector<HTMLButtonElement>(`[data-sidebar-session-id="${candidateId}"] button[data-testid="session-archive-${candidateId}"]`);
      return {
        active: [...(tree?.querySelectorAll<HTMLElement>("[data-sidebar-session-id]") ?? [])]
          .map((row) => row.getAttribute("data-sidebar-session-id")),
        archivedSection: Boolean(document.querySelector<HTMLElement>("[data-global-archived-sessions]")),
        archiveButtonDisabled: button?.disabled ?? null,
        archiveButtonTitle: button?.title ?? null,
      };
    }, [workspace.workspaceId, candidate.sessionId]));
    if (!isRecord(value)
      || !Array.isArray(value.active)
      || !value.active.every((sessionId) => typeof sessionId === "string")
      || typeof value.archivedSection !== "boolean"
      || (value.archiveButtonDisabled !== null && typeof value.archiveButtonDisabled !== "boolean")
      || (value.archiveButtonTitle !== null && typeof value.archiveButtonTitle !== "string")) {
      throw new Error(`Sidebar archive facts were malformed: ${JSON.stringify(value)}`);
    }
    return { active: value.active, archivedSection: value.archivedSection, archiveButtonDisabled: value.archiveButtonDisabled, archiveButtonTitle: value.archiveButtonTitle };
  }

  /** True once the undo pill is on screen and its slide-in has finished, i.e. when a person would reach for it. */
  // TODO(primitive): user.click should wait for a target's entrance animation to settle.
  async function undoToastSettled(): Promise<boolean> {
    const value = await seed.evalIn(app, () => {
      const pill = document.querySelector<HTMLElement>("[data-undo-toast]");
      const toast = pill?.closest("[data-sonner-toast]");
      if (!(toast instanceof HTMLElement)) return false;
      return toast.dataset.mounted === "true"
        && toast.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
    });
    return value === true;
  }

  return { app, engine, workspace, workspacePath, candidate, neighbor, archivedAt, sidebar, undoToastSettled,
    // The rename UI rejects blank input; arrange persisted legacy titles through the native API.
    setCandidateTitle: (title: string) => seed.evalIn(app, browserScript(async (workspaceId, sessionId, title) => {
      // Desktop bridge first; the app in a browser keeps the address in localStorage.
      const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
      const port = localStorage.getItem("openwork.server.port");
      const baseUrl = info?.running && info.baseUrl ? String(info.baseUrl) : port ? "http://127.0.0.1:" + port : "";
      const token = info?.running && info.baseUrl ? String(info.ownerToken ?? info.clientToken ?? "") : localStorage.getItem("openwork.server.token") ?? "";
      if (!baseUrl) throw new Error("OpenWork server is unavailable");
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/workspace/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Setting fixture title failed with HTTP ${response.status}`);
      const session = await response.json();
      if (session.id !== sessionId || typeof session.title !== "string") throw new Error("Unexpected session title response");
      return session.title;
    }, [workspace.workspaceId, candidate.sessionId, title]), { awaitPromise: true, timeoutMs: 20_000 }),
    archiveToast: () => seed.evalIn(app, () => {
      const pill = document.querySelector<HTMLElement>("[data-undo-toast]");
      const message = pill?.querySelector("p");
      const bounds = pill?.getBoundingClientRect();
      return {
        text: message?.textContent,
        fullTitle: message?.querySelector("[title]")?.getAttribute("title"),
        truncated: Boolean(message && message.scrollWidth > message.clientWidth && getComputedStyle(message).textOverflow === "ellipsis"),
        fitsViewport: Boolean(bounds && bounds.left >= 0 && bounds.right <= window.innerWidth),
        actionsInside: Boolean(pill && bounds && [...pill.querySelectorAll("button")].every(button => {
          const action = button.getBoundingClientRect();
          return action.width > 0 && action.left >= bounds.left && action.right <= bounds.right;
        })),
      };
    }),
    // Native desktop menus are OS widgets, observed through the development bridge.
    nativeMenu: () => seed.evalIn(app, () => window.__OPENWORK_ELECTRON__.contextMenu.inspect(), { awaitPromise: true }),
    dismissMenu: () => seed.evalIn(app, () => window.__OPENWORK_ELECTRON__.contextMenu.dismiss(), { awaitPromise: true }),
    mutationRequests: () => seed.evalIn(app, () => window.__archiveAvailabilityRequests),
  };
}

export type SidebarRouteWorkspace = { id: string; name: string; loading: boolean; error: string | null };
export type SidebarRouteSession = { id: string; title: string };
export type SidebarRouteFacts = {
  selectedWorkspaceId: string;
  workspaces: SidebarRouteWorkspace[];
  sessionsByWorkspaceId: Record<string, SidebarRouteSession[]>;
};

function parseSidebarRouteFacts(value: unknown): SidebarRouteFacts {
  if (!isRecord(value) || typeof value.selectedWorkspaceId !== "string" || !Array.isArray(value.workspaces) || !isRecord(value.sessionsByWorkspaceId)) {
    throw new Error(`Route inspector slice was unavailable: ${JSON.stringify(value)}`);
  }
  const workspaces: SidebarRouteWorkspace[] = [];
  for (const workspace of value.workspaces) {
    if (!isRecord(workspace) || typeof workspace.id !== "string" || typeof workspace.name !== "string" || typeof workspace.loading !== "boolean") {
      throw new Error(`Route inspector workspace was invalid: ${JSON.stringify(workspace)}`);
    }
    workspaces.push({
      id: workspace.id,
      name: workspace.name,
      loading: workspace.loading,
      error: typeof workspace.error === "string" ? workspace.error : null,
    });
  }
  const sessionsByWorkspaceId: Record<string, SidebarRouteSession[]> = {};
  for (const [workspaceId, sessions] of Object.entries(value.sessionsByWorkspaceId)) {
    if (!Array.isArray(sessions)) throw new Error(`Route inspector sessions for ${workspaceId} were invalid: ${JSON.stringify(sessions)}`);
    sessionsByWorkspaceId[workspaceId] = sessions.map((session) => {
      if (!isRecord(session) || typeof session.id !== "string" || typeof session.title !== "string") {
        throw new Error(`Route inspector session was invalid: ${JSON.stringify(session)}`);
      }
      return { id: session.id, title: session.title };
    });
  }
  return { selectedWorkspaceId: value.selectedWorkspaceId, workspaces, sessionsByWorkspaceId };
}

/**
 * Two empty workspaces on one desktop. `other` is created last, which selects
 * it and expands its sidebar group; the group stays expanded after the spec
 * returns to `home`, so `other`'s rows keep rendering while it is not selected.
 */
export async function externalSessionVisibility(seed: Seed) {
  const app = await seed.desktop({ name: "sidebar-external-session-visibility" });
  const repoRoot = app.workspaceRoot;
  if (!repoRoot) throw new Error("External session visibility needs a spawned desktop with a known workspace root.");
  // Real checkout directories avoid conflating session-list freshness with a
  // missing-directory cold start in OpenCode.
  const homePath = `${repoRoot}/apps/app`;
  const otherPath = `${repoRoot}/apps/server`;
  const home = await seed.workspace(app, homePath);
  const other = await additionalWorkspace(seed, app, otherPath);
  const workspaceDirectories = new Map([
    [home.workspaceId, homePath],
    [other.workspaceId, otherPath],
  ]);
  // TODO(primitive): seed.desktop should accept an initial viewport for Electron surfaces.
  // The sidebar renders its workspace rows only on a desktop-width viewport.
  await app.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1_400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // These empty workspaces do not send prompts. Let the model catalog settle
  // and explicitly close its picker before testing sidebar clicks: the missing
  // default-model prompt can otherwise appear between hit-testing and clicking.
  await readAvailableModels(app);
  await seed.evalIn(app, () => {
    const close = document.querySelector<HTMLElement>('[data-slot="dialog-content"] [data-slot="dialog-close"]');
    if (!(close instanceof HTMLElement)) throw new Error("Model picker close control unavailable");
    close.click();
  });
  await waitFor(app, () => (!document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')), {
    timeoutMs: 30_000,
    label: "model picker backdrop dismissed before sidebar interaction",
  });
  const rawServerInfo = await seed.evalIn(app, () => (window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo")), {
    awaitPromise: true,
    timeoutMs: 30_000,
  });
  if (!isRecord(rawServerInfo) || typeof rawServerInfo.baseUrl !== "string") {
    throw new Error(`OpenWork server info was unavailable: ${JSON.stringify(rawServerInfo)}`);
  }
  const serverUrl = new URL(rawServerInfo.baseUrl);
  const serverToken = typeof rawServerInfo.ownerToken === "string"
    ? rawServerInfo.ownerToken
    : typeof rawServerInfo.clientToken === "string"
      ? rawServerInfo.clientToken
      : "";
  if (!serverToken) throw new Error("OpenWork server info did not include a token.");
  let externalServerUrl = serverUrl.origin;
  if (app.handle.hostKind === "daytona") {
    const sandboxId = app.handle.sandboxId?.trim();
    if (!sandboxId) throw new Error("Daytona desktop did not expose its sandbox id.");
    await using previewHost = daytonaSandbox(sandboxId);
    if (!previewHost.previewUrl) throw new Error("Daytona host cannot expose the OpenWork server port.");
    externalServerUrl = await previewHost.previewUrl(Number(serverUrl.port));
  }
  return {
    app,
    home,
    other,
    homePath,
    engine: resolveEvalEngine(),
    async observeSessionRequests(workspaceId: string, holdMetadataExcept?: readonly string[]) {
      const debuggerUrl = app.client.webSocketDebuggerUrl;
      if (!debuggerUrl) throw new Error("Session request witness needs a desktop CDP endpoint");
      const socket = new WebSocket(debuggerUrl);
      const ready = Promise.withResolvers<void>();
      const requests: { method: string; path: string; requestId: string; startedAt: number }[] = [];
      const prefixes = ["workspace", "w"].map((mount) => `/${mount}/${encodeURIComponent(workspaceId)}/opencode2/api/session`);
      const ended = new Set<string>();
      const commands = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
      let nextCommandId = 2;
      let held: { requestId: string; networkId: string; sessionId: string; startedAt: number } | undefined;
      let released = false;
      let holdTimeout: ReturnType<typeof setTimeout> | undefined;
      let failure: Error | undefined;
      let disposed = false;
      const command = async (method: string, params = {}) => {
        const id = nextCommandId++;
        const result = Promise.withResolvers<void>();
        commands.set(id, result);
        const timeout = setTimeout(() => result.reject(new Error(`Session request witness timed out: ${method}`)), 15_000);
        try {
          socket.send(JSON.stringify({ id, method, params }));
          await result.promise;
        } finally {
          clearTimeout(timeout);
          commands.delete(id);
        }
      };
      const releaseMetadata = async () => {
        if (!held || released) return;
        released = true;
        clearTimeout(holdTimeout);
        await command("Fetch.continueRequest", { requestId: held.requestId });
      };
      const fail = () => {
        if (disposed) return;
        failure = new Error("Session request witness lost its CDP connection");
        ready.reject(failure);
        for (const result of commands.values()) result.reject(failure);
      };
      const timeout = setTimeout(() => ready.reject(new Error("Session request witness did not become ready")), 15_000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Network.enable" })));
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);
      socket.addEventListener("message", (event) => {
        const message: unknown = JSON.parse(String(event.data));
        if (!isRecord(message)) return;
        if (message.id === 1) {
          if (message.error) ready.reject(new Error("Session request witness could not enable Network events"));
          else ready.resolve();
        }
        const result = typeof message.id === "number" ? commands.get(message.id) : undefined;
        if (result) {
          if (message.error) result.reject(new Error(`Session request witness CDP command ${message.id} failed`));
          else result.resolve();
        }
        if (!isRecord(message.params)) return;
        if (["Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"].includes(String(message.method))
          && typeof message.params.requestId === "string") ended.add(message.params.requestId);
        if (message.method === "Fetch.requestPaused" && typeof message.params.requestId === "string") {
          const request = message.params.request;
          const networkId = message.params.networkId;
          const network = requests.find((item) => item.requestId === networkId);
          const prefix = network && prefixes.find((prefix) => network.path.startsWith(`${prefix}/`));
          const sessionId = prefix && network?.path.slice(prefix.length + 1);
          // One-shot hold; source reads and non-metadata traffic pass through.
          if (!held && holdMetadataExcept && isRecord(request) && request.method === "GET"
            && network && sessionId && !sessionId.includes("/") && !holdMetadataExcept.includes(decodeURIComponent(sessionId))) {
            held = { requestId: message.params.requestId, networkId: network.requestId, sessionId: decodeURIComponent(sessionId), startedAt: network.startedAt };
            // Fail closed at 1.5s, leaving headroom below the adapter's 2s abort.
            holdTimeout = setTimeout(() => void releaseMetadata().catch((error: Error) => { failure = error; }),
              Math.max(0, 1_500 - (performance.now() - held.startedAt)));
          } else {
            void command("Fetch.continueRequest", { requestId: message.params.requestId }).catch((error: Error) => { failure = error; });
          }
          return;
        }
        if (message.method !== "Network.requestWillBeSent") return;
        const request = message.params.request;
        if (!isRecord(request) || typeof request.url !== "string" || typeof request.method !== "string") return;
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, "");
        if (url.origin !== serverUrl.origin || !prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return;
        if (typeof message.params.requestId !== "string") return;
        // Retain only identity/timing/method/path, never headers or bodies.
        requests.push({ method: request.method, path, requestId: message.params.requestId, startedAt: performance.now() });
      });
      try {
        await ready.promise;
        if (holdMetadataExcept) await command("Fetch.enable", {
          patterns: prefixes.map((prefix) => ({ urlPattern: `${serverUrl.origin}${prefix}/*`, requestStage: "Request" })),
        });
      } catch (error) {
        disposed = true;
        socket.close();
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      return {
        snapshot() {
          if (failure) throw failure;
          return {
            lists: requests.filter((request) => request.method === "GET" && prefixes.includes(request.path)).length,
            reads: requests.filter((request) => request.method === "GET").map((request) => request.path),
            held: held ? {
              sessionId: held.sessionId,
              elapsedMs: performance.now() - held.startedAt,
              pending: !released && !ended.has(held.networkId),
            } : null,
          };
        },
        releaseMetadata,
        async [Symbol.asyncDispose]() {
          clearTimeout(holdTimeout);
          try {
            if (holdMetadataExcept) await command("Fetch.disable");
          } finally {
            disposed = true;
            socket.close();
          }
        },
      };
    },
    async observeWorkspaceEvents(workspaceId: string) {
      const abort = new AbortController();
      const url = new URL(`${externalServerUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode2/api/event`);
      // A client-supplied location must not override its authenticated mount.
      url.searchParams.set("location[directory]", workspaceId === home.workspaceId ? otherPath : homePath);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${serverToken}` },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
      });
      if (!response.ok || !response.body) throw new Error(`Workspace event stream returned ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = "";
      let failure: unknown;
      const finished = (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            received += decoder.decode(chunk.value, { stream: true });
          }
        } catch (error) {
          if (!abort.signal.aborted) failure = error;
        }
      })();
      return {
        snapshot() {
          if (failure) throw failure;
          return received;
        },
        async [Symbol.asyncDispose]() {
          abort.abort();
          await reader.cancel().catch(() => undefined);
          await finished;
        },
      };
    },
    async serverSessionIds(workspaceId: string): Promise<string[]> {
      const response = await engineSessionProbe({ engine: resolveEvalEngine(), serverUrl: externalServerUrl, token: serverToken, workspaceId }).list();
      if (!response.ok) throw new Error(`Session list returned HTTP ${response.status}`);
      return response.data.map((session) => session.id);
    },
    async forkSessionOutsideWindow(workspaceId: string, sessionId: string) {
      const base = `${externalServerUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode2/api`;
      const sessionRoute = `/session/${encodeURIComponent(sessionId)}`;
      const request = async (path: string, body?: unknown): Promise<unknown> => {
        const response = await fetch(`${base}${path === "/export" ? "/experimental" : ""}${sessionRoute}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { Authorization: `Bearer ${serverToken}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`External fork setup ${path} returned HTTP ${response.status}`);
        return response.status === 204 ? null : response.json();
      };
      // A settled native shell message supplies a fork boundary without a model.
      await request("/shell", { command: "printf 'External fork history\\n'" });
      const sourceBefore = { info: await request(""), history: await request("/export") };
      const response = await request("/fork", { boundary: { type: "through" } });
      if (!isRecord(response) || !isRecord(response.data) || typeof response.data.id !== "string" || typeof response.data.title !== "string") {
        throw new Error("Native fork did not return a complete session identity and title");
      }
      return {
        id: response.data.id,
        title: response.data.title,
        sourceBefore,
        sourceAfter: { info: await request(""), history: await request("/export") },
      };
    },
    /** The sidebar's own per-workspace session lists and load state. */
    // TODO(primitive): probe.route should expose the sidebar's per-workspace session lists.
    async route(): Promise<SidebarRouteFacts> {
      return parseSidebarRouteFacts(await seed.evalIn(app, () => {
        const route = window.__openwork?.slice?.("route");
        if (!route) return null;
        return {
          selectedWorkspaceId: String(route.selectedWorkspaceId ?? ""),
          workspaces: (route.workspaces ?? []).map((workspace) => ({
            id: String(workspace.id),
            name: String(workspace.displayNameResolved ?? ""),
            loading: Boolean(workspace.loading),
            error: typeof workspace.error === "string" ? workspace.error : null,
          })),
          sessionsByWorkspaceId: Object.fromEntries(Object.entries(route.sessionsByWorkspaceId ?? {}).map(([workspaceId, sessions]) => [
            workspaceId,
            (sessions ?? []).map((session) => ({ id: String(session?.id ?? ""), title: String(session?.title ?? "") })),
          ])),
        };
      }));
    },
    /**
     * Creates a session the way another client would: straight against the
     * OpenWork server's workspace mount, never through the desktop's UI state.
     */
    // TODO(primitive): seed.externalSession should create a session on the server without touching the renderer.
    async createSessionOutsideWindow(workspaceId: string, title: string, requestedDirectory?: string): Promise<string> {
      const directory = requestedDirectory ?? workspaceDirectories.get(workspaceId);
      if (!directory) throw new Error(`No directory is registered for workspace ${workspaceId}.`);
      const probe = engineSessionProbe({
        engine: resolveEvalEngine(),
        serverUrl: externalServerUrl,
        token: serverToken,
        workspaceId,
      });
      const findCreatedSession = async (): Promise<string | null> => {
        try {
          const response = await probe.list();
          return response.ok ? response.data.find((session) => session.title === title)?.id ?? null : null;
        } catch {
          return null;
        }
      };

      let lastError = "no response";
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const existing = await findCreatedSession();
        if (existing) return existing;
        try {
          const response = await probe.create(directory, title);
          if (response.ok && response.data) return response.data.id;
          lastError = `HTTP ${response.status}: ${JSON.stringify(response.body)}`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        // A timed-out POST may have committed before its response was lost.
        // Check by unique title before the next non-idempotent attempt.
        const created = await findCreatedSession();
        if (created) return created;
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1_000));
      }
      throw new Error(`Creating a session outside the window failed after 4 attempts: ${lastError}`);
    },
  };
}

export async function macSidebar(seed: Seed) {
  const world = await oneWorkspace(seed, "mac-sidebar-toggle-clearance", ["Mac sidebar clearance"], "electron");
  return {
    ...world,
    clearViewport: () => world.app.client.send("Emulation.clearDeviceMetricsOverride"),
    // TODO(primitive): user.setWindowFullscreen. Called immediately after trusted
    // user input, a Chromium fullscreen request enters the real Electron window
    // and exercises its native events, rather than changing CSS markers.
    async fullscreen(enabled: boolean) {
      await evaluate(world.app.client, enabled
        ? () => document.documentElement.requestFullscreen()
        : () => document.exitFullscreen());
    },
  };
}
