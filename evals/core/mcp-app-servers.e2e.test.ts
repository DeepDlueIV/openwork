import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appSource, appTitle, launchInput, mcpAppServers, payload, record, reservationId, rows, toolNames } from "../worlds/mcp-app-servers.ts";

const test = spec.world(mcpAppServers, {
  resources: { surfaces: ["web"], services: ["den", "mock"] },
  timeout: 600_000,
});

const composedTools = ["open_app", toolNames.live, toolNames.connection, toolNames.workflow, toolNames.reserve];
const pricedLine = `${launchInput.quantity} × ${launchInput.sku} at 7`;
const reservedLine = `Reserved ${reservationId}`;
const reservation = { sku: launchInput.sku, quantity: launchInput.quantity };

test("an owner composes an App that is its own MCP server, and a teammate uses it from a standard host once its Plugin is shared", async ({ world, user, probe, step }) => {
  const appTile = (resourceUri: string) => ({
    serverName: expect.stringMatching(/^openwork-app-host-connect-[0-9a-f]{12}$/), connectionId: world.created.appId, toolName: "open_app",
    projectedToolName: expect.stringMatching(/^openwork-app-host-connect-[0-9a-f]{12}_open_app$/), resourceUri, title: appTitle,
  });
  const appName = `plugin:${world.created.pluginId}:${world.created.appId}`;
  const clientCalls = (persona: "owner" | "member") => world.requests.filter(request => request.via === "client" && request.persona === persona && request.method === "tools/call");
  const clientToolNames = (persona: "owner" | "member") => clientCalls(persona).map(request => request.params.name);
  // open_app first, then the two reads the App makes on open in either order, then one call per click.
  const expectCalls = (persona: "owner" | "member", clicked: string[]) => {
    const names = clientToolNames(persona);
    expect(names[0]).toBe("open_app");
    expect(names.slice(1, 3).sort()).toEqual([toolNames.connection, toolNames.live].sort());
    expect(names.slice(3)).toEqual(clicked);
  };
  const clientCall = (persona: "owner" | "member", name: string) => clientCalls(persona).find(request => request.params.name === name);
  // One App frame is open at a time; it stays open across the steps that click in it.
  let frame: Awaited<ReturnType<typeof world.frame>> | undefined;
  await using _openFrame = { [Symbol.asyncDispose]: async () => { await frame?.[Symbol.asyncDispose](); } };
  const open = async (persona: "owner" | "member") => {
    await frame?.[Symbol.asyncDispose]();
    frame = undefined;
    await user.navigate(world.url(persona));
    await user.see({ text: /^Ready$/ }, { timeoutMs: 60_000 });
    await user.type({ label: "Launch arguments" }, JSON.stringify({ input: launchInput }), { replace: true });
    await user.click({ role: "button", label: "Open app" });
    await user.see({ text: "App connected" }, { timeoutMs: 60_000 });
    frame = await world.frame();
    return user.on(frame);
  };
  // Opening runs only the reads: the pricing date and the Inventory price load, and the reservation waits for a click.
  const opened = async (persona: "owner" | "member", revision: string, sinceIso: string) => {
    const appUser = await open(persona);
    await appUser.see({ role: "heading", label: appTitle });
    await appUser.see({ text: `Ready — ${revision}` });
    await appUser.see({ testId: "pricing-date" }, { text: /^Prices as of \d{4}-\d{2}-\d{2}$/, timeoutMs: 90_000 });
    await appUser.see({ testId: "order-line" }, { text: pricedLine, timeoutMs: 90_000 });
    expect((await world.inventoryCalls({ sinceIso, atLeast: 1 })).map(call => call.args)).toEqual([{ sku: launchInput.sku }]);
    expect(await world.reservations({ sinceIso })).toEqual([]);
    return appUser;
  };
  const reserve = async (appUser: Awaited<ReturnType<typeof opened>>) => {
    await appUser.click({ role: "button", label: "Reserve stock" });
    await appUser.see({ testId: "reservation" }, { text: reservedLine, timeoutMs: 90_000 });
  };
  const calculate = async (appUser: Awaited<ReturnType<typeof opened>>) => {
    await appUser.click({ role: "button", label: "Calculate total" });
    await appUser.see({ testId: "total" }, { text: "42", timeoutMs: 90_000 });
  };
  const refused = async (persona: "member" | "outsider", resourceUri: string) => {
    expect((await world.rpc(persona, "app", "tools/list", {})).rpcError).toMatchObject({ code: -32600, data: { error: "mcp_app_not_found" } });
    expect((await world.rpc(persona, "app", "tools/call", { name: toolNames.workflow, arguments: { quantity: 1, unitPrice: 1 } })).rpcError).toMatchObject({ data: { error: "mcp_app_not_found" } });
    expect((await world.rpc(persona, "app", "resources/read", { uri: resourceUri })).rpcError).toMatchObject({ data: { error: "mcp_app_not_found" } });
    expect((await world.index(persona)).some(server => server.connectionId === world.created.appId)).toBe(false);
  };
  let ownerApp: Awaited<ReturnType<typeof opened>> | undefined;
  let ownerSince = "";
  let updatedResourceUri = "";

  await step("a new organization can build Apps without a platform admin turning anything on", async () => {
    expect([...world.builderToolsByDefault].sort()).toEqual(["create_app", "read_app", "update_app"]);
    const capabilities = record((await probe.api(world.den.admin, `/v1/admin/organizations/${world.organizationId}/capabilities`)).body).capabilities;
    expect(record(capabilities)).not.toHaveProperty("appMcpServers");
  });

  await step("before: a teammate the App's Plugin is not shared with is refused by its MCP server", async () => {
    await refused("member", world.created.resourceUri);
    await user.navigate(world.url("member"));
    await user.see({ testId: "viewer" }, { text: "Signed in as a teammate" });
    await user.see({ text: "The App is not available." }, { timeoutMs: 60_000 });
    expect((await probe.dom("iframe")).elements).toHaveLength(0);
    await user.screenshot();
  });

  await step("the owner opens the App from its own MCP URL, and only its reads run: the pricing date and the Inventory price load, and the reservation waits for a click", async () => {
    expect(world.created.mcpUrl.endsWith(`/mcp/agent/connections/${world.created.appId}`)).toBe(true);
    const listed = rows((await world.rpc("owner", "app", "tools/list", {})).tools);
    expect(listed.map(tool => tool.name)).toEqual(composedTools);
    const byName = Object.fromEntries(listed.map(tool => [tool.name, tool]));
    expect(byName.open_app).toMatchObject({ annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: world.created.resourceUri, visibility: ["model", "app"] } } });
    expect(byName[toolNames.live]).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", properties: { timeZone: { type: "string" } } } });
    // The provider marks its lookup read-only and not destructive, so the App server says so too.
    expect(byName[toolNames.connection]).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", required: ["sku"] } });
    expect(byName[toolNames.workflow]).toMatchObject({ annotations: { readOnlyHint: false }, inputSchema: { type: "object", required: ["quantity", "unitPrice"] } });
    // The reservation is not marked read-only, so it is not read-only here.
    expect(byName[toolNames.reserve]).toMatchObject({ annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: "object", required: ["sku", "quantity"] } });
    ownerSince = new Date().toISOString();
    ownerApp = await opened("owner", "revision one", ownerSince);
    await user.see({ testId: "viewer" }, { text: "Signed in as the owner" });
    expectCalls("owner", []);
    expect(clientCall("owner", toolNames.live)?.params.arguments).toEqual({ timeZone: "UTC" });
    expect(payload(clientCall("owner", toolNames.live)?.result ?? {})).toMatchObject({ status: "executed" });
    expect(clientCall("owner", toolNames.connection)?.params.arguments).toEqual({ sku: launchInput.sku });
    await user.screenshot();
  });

  await step("one click on Reserve stock makes exactly one reservation", async () => {
    if (!ownerApp) throw new Error("The owner's App is not open");
    await reserve(ownerApp);
    expectCalls("owner", [toolNames.reserve]);
    expect(clientCall("owner", toolNames.reserve)?.params.arguments).toEqual(reservation);
    expect((await world.reservations({ sinceIso: ownerSince, atLeast: 1 })).map(call => call.args)).toEqual([reservation]);
    expect(await world.inventoryCalls({ sinceIso: ownerSince })).toHaveLength(1);
    await user.screenshot();
  });

  await step("after: one click on Calculate total runs the pricing Workflow, and the owner sees 42", async () => {
    if (!ownerApp) throw new Error("The owner's App is not open");
    await calculate(ownerApp);
    expectCalls("owner", [toolNames.reserve, toolNames.workflow]);
    const total = clientCall("owner", toolNames.workflow);
    expect(total?.params.arguments).toEqual({ quantity: launchInput.quantity, unitPrice: 7 });
    expect(payload(total?.result ?? {})).toMatchObject({ status: "executed", value: { total: 42 } });
    expect(world.requests.filter(request => request.via === "client").every(request => request.endpoint === "app")).toBe(true);
    expect((await world.hostState()).uri).toBe(world.created.resourceUri);
    await user.screenshot();
  });

  await step("the owner's OpenWork Connect lists the App for its App host, opens it by launch reference, and refuses tools an App may not bind", async () => {
    const index = await world.index("owner");
    // Listed for the App host to open, never exposed to the model as a server of its own.
    expect(index.filter(server => server.connectionId === world.created.appId)).toEqual([{
      connectionId: world.created.appId, name: appTitle, description: null, url: world.created.mcpUrl, exposeDirectly: false,
    }]);
    const search = payload(await world.call("owner", "search_capabilities", { query: appTitle, type: "marketplace" }));
    expect(rows(search.matches).find(match => match.name === appName)).toMatchObject({ kind: "mcp_app", mcpApp: { resourceUri: world.created.resourceUri } });
    const opened = await world.call("owner", "execute_capability", { name: appName });
    expect(opened._meta).toEqual({ "openwork/mcpApp": { connectionId: world.created.appId, toolName: "open_app", resourceUri: world.created.resourceUri, arguments: { input: {} } } });
    const broken = await world.call("owner", "create_app", {
      ...appSource("never published"), title: "Unusable tools",
      tools: [{ name: "missing_tool", description: "A tool with no capability behind it.", capability: "mcp:not-a-connection:missing" }],
    });
    expect(broken.isError).toBe(true);
    expect(payload(broken)).toMatchObject({ error: "mcp_app_tool_unavailable", message: expect.stringContaining("missing_tool") });
    const writer = await world.call("owner", "create_app", {
      ...appSource("never published"), title: "Plugin sharer",
      tools: [{ name: "share_plugin", description: "Share a Plugin with a teammate.", capability: "postPluginsAccess" }],
    });
    expect(writer.isError).toBe(true);
    expect(payload(writer)).toMatchObject({ error: "mcp_app_tool_unavailable", message: expect.stringContaining("changes data") });
    expect((await world.index("owner")).some(server => ["Unusable tools", "Plugin sharer"].includes(String(server.name)))).toBe(false);
  });

  await step("the App catalog lists an entry that opens the App through its own server", async () => {
    // The entry opens the App through its own server, which the desktop finds by App id.
    expect(await world.catalogEntries("owner")).toEqual([expect.objectContaining(appTile(world.created.resourceUri))]);
  });

  await step("the owner shares only the App's Plugin, and the teammate finds the App and its MCP URL there", async () => {
    // The App's Workflow tools run through its own Plugin, so no separate Workflow grant is needed.
    const read = payload(await world.call("owner", "read_app", { appId: world.created.appId }));
    const workflowTools = rows(record(read.app).tools).filter(tool => String(tool.capability).startsWith("plugin:"));
    expect(workflowTools).toHaveLength(2);
    expect(workflowTools.map(tool => tool.capability)).toEqual(workflowTools.map(() => expect.stringMatching(new RegExp(`^plugin:${world.created.pluginId}:`))));
    await world.share();
    expect((await world.index("member")).some(server => server.connectionId === world.created.appId && server.url === world.created.mcpUrl)).toBe(true);
    const pluginUser = user.on(world.pluginWeb);
    await pluginUser.navigate(`${world.den.ref.webUrl}/dashboard/library/plugins/${world.created.pluginId}`);
    await pluginUser.see({ testId: "plugin-page" }, { timeoutMs: 120_000 });
    // The integrated plugin header reads its logo letter before the name.
    await pluginUser.see({ role: "heading", label: new RegExp(`${appTitle}$`) });
    await pluginUser.see({ testId: "whats-inside" }, { text: new RegExp(appTitle) });
    await pluginUser.see({ testId: "app-mcp-servers" }, { text: new RegExp(`Use in another app\\s+${appTitle} MCP URL`) });
    await pluginUser.screenshot();
  });

  await step("after: the teammate uses the same App URL, tools, and Workflows as themselves", async () => {
    const sinceIso = new Date().toISOString();
    const memberApp = await opened("member", "revision one", sinceIso);
    await user.see({ testId: "viewer" }, { text: "Signed in as a teammate" });
    await reserve(memberApp);
    await calculate(memberApp);
    expectCalls("member", [toolNames.reserve, toolNames.workflow]);
    expect(payload(clientCall("member", toolNames.workflow)?.result ?? {})).toMatchObject({ status: "executed", value: { total: 42 } });
    expect((await world.inventoryCalls({ sinceIso, atLeast: 1 })).map(call => call.args)).toEqual([{ sku: launchInput.sku }]);
    expect((await world.reservations({ sinceIso, atLeast: 1 })).map(call => call.args)).toEqual([reservation]);
    await user.screenshot();
  });

  await step("an update keeps the same MCP URL and tools, and the owner's App opens on the new revision", async () => {
    const { updated } = await world.update();
    updatedResourceUri = updated.resourceUri;
    expect(updated.serverPath).toBe(world.created.serverPath);
    expect(updated.revisionId).not.toBe(world.created.revisionId);
    const listed = rows((await world.rpc("owner", "app", "tools/list", {})).tools);
    expect(listed.map(tool => tool.name)).toEqual(composedTools);
    expect(listed[0]).toMatchObject({ _meta: { ui: { resourceUri: updated.resourceUri } } });
    expect(rows((await world.rpc("owner", "app", "resources/read", { uri: world.created.resourceUri })).contents)[0]).toMatchObject({ uri: world.created.resourceUri });
    expect(record((await world.rpc("owner", "app", "tools/call", { name: "open_app", arguments: {} })).structuredContent).app).toMatchObject({ revisionId: updated.revisionId });
    await opened("owner", "revision two", new Date().toISOString());
    expect((await world.hostState()).uri).toBe(updated.resourceUri);
    await user.screenshot();
  });

  await step("after the update, the App catalog opens the App's new revision for the owner and the teammate", async () => {
    expect(await world.catalogEntries("owner")).toEqual([expect.objectContaining(appTile(updatedResourceUri))]);
    expect(await world.catalogEntries("member")).toEqual([expect.objectContaining(appTile(updatedResourceUri))]);
  });

  await step("a teammate without access still cannot use either revision", async () => {
    await frame?.[Symbol.asyncDispose]();
    frame = undefined;
    for (const resourceUri of [world.created.resourceUri, updatedResourceUri]) await refused("outsider", resourceUri);
    await user.navigate(world.url("outsider"));
    await user.see({ testId: "viewer" }, { text: "Signed in as a teammate without access" });
    await user.see({ text: "The App is not available." }, { timeoutMs: 60_000 });
    expect((await probe.dom("iframe")).elements).toHaveLength(0);
    await user.screenshot();
  });
});

