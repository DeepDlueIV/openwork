import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { openArtifactOptions, waitForAppCreationStage, waitForDashboardTiles } from "@openwork/behaviors";
import { appTitle, buildPrompt, buildReply, chatPrompt, chatReply, launchInput, mcpAppServersChat, mcpAppServersChatOwnSignIn, pricerTitle, reservationId, signInPrompt, signInReply } from "../worlds/mcp-app-servers.ts";

const test = spec.world(mcpAppServersChat, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { commands: ["bun", "pnpm", "opencode"] }, timeout: 600_000,
});
const signInTest = spec.world(mcpAppServersChatOwnSignIn, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { commands: ["bun", "pnpm", "opencode"] }, timeout: 600_000,
});

const orderLine = `${launchInput.quantity} × ${launchInput.sku}`;
const pricedLine = `${orderLine} at 7`;
const reservedLine = `Reserved ${reservationId}`;
const reservation = { sku: launchInput.sku, quantity: launchInput.quantity };
const emptyDashboardHeading = "Pin the artifacts you check every day";
const authFailure = /This App's connection needs authentication/;

test("an owner builds an App in chat, uses it beside the conversation, and keeps it on their dashboard", async ({ world, agent, user, probe, step }) => {
  const lookups = async (sinceIso: string) => (await world.inventoryCalls({ sinceIso, atLeast: 1 })).map(call => call.args);
  let frame: Awaited<ReturnType<typeof world.appFrame>> | undefined;
  await using _openFrame = { [Symbol.asyncDispose]: async () => { await frame?.[Symbol.asyncDispose](); } };
  const focus = async (title: string) => {
    await frame?.[Symbol.asyncDispose]();
    frame = await world.appFrame(title);
    return user.on(frame);
  };
  const closeApp = async () => {
    await frame?.[Symbol.asyncDispose]();
    frame = undefined;
  };
  let builtAt = "";
  let pricer: Awaited<ReturnType<typeof focus>> | undefined;

  await step("while the agent is still writing the App, the owner sees its progress and no preview", async () => {
    expect((await probe.dom("[data-built-app-preview]")).elements).toHaveLength(0);
    await world.holdCreation(true);
    builtAt = new Date().toISOString();
    await agent.send(buildPrompt);
    await user.see({ text: /Creating MCP App “/ });
    expect(await waitForAppCreationStage(probe, "writing")).toBe(1);
    expect((await probe.dom("[data-built-app-preview]")).elements).toHaveLength(0);
    await user.screenshot();
    await world.holdCreation(false);
  });

  await step("after: the checked App opens beside the conversation and runs only its read-only tools", async () => {
    await user.see({ text: buildReply }, { timeoutMs: 120_000 });
    const calls = (await world.den.mocks.inventory.agentRequests({ promptMarker: buildPrompt })).filter(request => request.kind === "tool");
    expect(calls.map(call => call.toolName)).toEqual([expect.stringMatching(/prepare_app$/), expect.stringMatching(/create_app$/)]);
    expect(await waitForAppCreationStage(probe, "ready")).toBe(1);
    await user.see({ role: "button", label: "Open preview" });
    expect((await probe.dom("[data-built-app-preview]")).elements).toHaveLength(1);
    pricer = await focus(pricerTitle);
    await pricer.see({ role: "heading", label: pricerTitle });
    await pricer.see({ testId: "pricing-date" }, { text: /^Prices as of \d{4}-\d{2}-\d{2}$/, timeoutMs: 90_000 });
    await pricer.see({ testId: "order-line" }, { text: pricedLine, timeoutMs: 90_000 });
    await pricer.notSee({ testId: "total" });
    expect(await lookups(builtAt)).toEqual([{ sku: launchInput.sku }]);
    expect(await world.reservations({ sinceIso: builtAt })).toEqual([]);
    await user.screenshot();
  });

  await step("Share beside the preview opens the App's audience with people and team controls", async () => {
    await user.notSee({ text: "Who can use it" });
    await user.click({ role: "button", label: "Share" });
    await user.see({ text: "Who can use it" });
    await user.see({ role: "button", label: "Add person" });
    await user.see({ role: "button", label: "Add team" });
    await user.screenshot();
    await user.click({ role: "button", label: "Cancel" });
  });

  await step("a Reserve stock click from the App's own script is refused, because it is not a person's click", async () => {
    if (!pricer || !frame) throw new Error(`${pricerTitle} is not open`);
    await world.scriptedClick(frame, "Reserve stock");
    await pricer.see({ role: "alert" }, { text: /approval/i, timeoutMs: 60_000 });
    expect(await world.reservations({ sinceIso: builtAt })).toEqual([]);
    await user.screenshot();
  });

  await step("after: one trusted click reserves the stock once, and Calculate total prices the order at 42", async () => {
    if (!pricer) throw new Error(`${pricerTitle} is not open`);
    await pricer.click({ role: "button", label: "Reserve stock" });
    await pricer.see({ testId: "reservation" }, { text: reservedLine, timeoutMs: 90_000 });
    await pricer.notSee({ role: "alert" });
    expect((await world.reservations({ sinceIso: builtAt, atLeast: 1 })).map(call => call.args)).toEqual([reservation]);
    expect(await lookups(builtAt)).toEqual([{ sku: launchInput.sku }]);
    await pricer.click({ role: "button", label: "Calculate total" });
    await pricer.see({ testId: "total" }, { text: "42", timeoutMs: 90_000 });
    await user.notSee({ text: "Allow App action?" });
    await user.screenshot();
  });

  await step("with its Cloud credential expired, an App the chat opens by name waits on a sign-in error", async () => {
    for (const id of [world.created.appId, world.created.pluginId]) expect(chatPrompt).not.toContain(id);
    await closeApp();
    await user.click({ role: "button", label: "Close panel" });
    await world.expireCloudCredentials("app-host");
    expect((await world.cloudCredentials()).liveAppHost).toBe(0);
    const openedAt = new Date().toISOString();
    await agent.send(chatPrompt);
    await user.see({ text: chatReply }, { timeoutMs: 120_000 });
    expect((await world.den.mocks.inventory.agentRequests({ promptMarker: chatPrompt })).find(request => request.kind === "tool")?.toolName).toMatch(/execute_capability$/);
    await user.see({ text: authFailure }, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: "Retry" });
    expect(await world.inventoryCalls({ sinceIso: openedAt })).toEqual([]);
    expect((await probe.dom(`[data-mcp-app-resource="${world.created.resourceUri}"] iframe`)).elements).toEqual([]);
    await user.screenshot();
  });

  await step("after: once OpenWork renews the credential, the same App loads with the requested order and no Retry click", async () => {
    await world.expireCloudCredentials("all");
    const expired = await world.cloudCredentials();
    expect(expired.live).toBe(0);
    const renewedAt = new Date().toISOString();
    await world.returnToWindow();
    await probe.eventually(() => world.cloudCredentials(), {
      within: 90_000, intervalMs: 1_000, label: "OpenWork mints a new Cloud credential",
      until: credentials => credentials.total > expired.total && credentials.liveAppHost > 0,
    });
    frame = await world.appFrameShowing(appTitle, pricedLine);
    const calculator = user.on(frame);
    await calculator.see({ role: "heading", label: appTitle });
    await calculator.see({ testId: "order-line" }, { text: pricedLine });
    await calculator.notSee({ testId: "total" });
    await user.notSee({ text: authFailure });
    await user.notSee({ role: "button", label: "Retry" });
    expect(await lookups(renewedAt)).toEqual([{ sku: launchInput.sku }]);
    expect(await world.reservations({ sinceIso: renewedAt })).toEqual([]);
    await user.screenshot();
  });

  await step("before: building an App does not place it on the owner's dashboard", async () => {
    await closeApp();
    await user.click({ role: "button", label: "Dashboard" });
    await user.see({ role: "heading", label: emptyDashboardHeading }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Add an artifact" });
    expect(await waitForDashboardTiles(probe, 0)).toBe(0);
    await user.screenshot();
  });

  await step("after: the owner finds the App by fuzzy search and uses it in a tile whose menu holds its actions", async () => {
    await user.click({ role: "button", label: "Add an artifact" });
    await user.type({ label: "Search artifacts" }, "qckordprcr", { replace: true });
    await user.click({ role: "option", label: `Add ${pricerTitle}` });
    expect(await waitForDashboardTiles(probe, 1, { settled: true })).toBe(1);
    pricer = await focus(pricerTitle);
    await pricer.see({ testId: "order-line" }, { text: pricedLine, timeoutMs: 90_000 });
    await closeApp();
    await openArtifactOptions(user, probe, world.den.admin, pricerTitle);
    await user.see({ role: "menuitem", label: `Refresh ${pricerTitle}` });
    await user.see({ role: "menuitem", label: `Share ${pricerTitle}` });
    await user.see({ role: "menuitem", label: `Remove ${pricerTitle} from dashboard` });
    await user.screenshot();
  });

  await step("removing the tile empties the dashboard, and Undo restores a working App", async () => {
    await user.click({ role: "menuitem", label: `Remove ${pricerTitle} from dashboard` });
    await user.see({ role: "heading", label: emptyDashboardHeading }, { timeoutMs: 15_000 });
    await user.see({ text: `Removed ${pricerTitle}` });
    expect(await waitForDashboardTiles(probe, 0)).toBe(0);
    await user.click({ role: "button", label: "Undo" });
    expect(await waitForDashboardTiles(probe, 1, { settled: true })).toBe(1);
    await user.notSee({ role: "heading", label: emptyDashboardHeading });
    pricer = await focus(pricerTitle);
    await pricer.see({ testId: "order-line" }, { text: pricedLine, timeoutMs: 90_000 });
    await user.screenshot();
  });
});

signInTest("a person not signed in to the service an App uses is asked to sign in, and the App reloads once they do", async ({ world, agent, user, probe, step }) => {
  let frame: Awaited<ReturnType<typeof world.appFrame>> | undefined;
  await using _openFrame = { [Symbol.asyncDispose]: async () => { await frame?.[Symbol.asyncDispose](); } };
  const focus = async () => {
    await frame?.[Symbol.asyncDispose]();
    frame = await world.appFrame(appTitle);
    return user.on(frame);
  };
  const signInRow = { text: `Sign in to ${world.inventoryName} to use ${appTitle}` };

  await step("signed in to Inventory, the owner opens the Order calculator and its price loads with no prompt", async () => {
    expect(await world.inventorySignedIn()).toBe(true);
    const openedAt = new Date().toISOString();
    await agent.send(chatPrompt);
    await user.see({ text: chatReply }, { timeoutMs: 120_000 });
    await (await focus()).see({ testId: "order-line" }, { text: pricedLine, timeoutMs: 90_000 });
    await user.notSee({ role: "button", label: "Sign in" });
    expect((await world.inventoryCalls({ sinceIso: openedAt, atLeast: 1 })).map(call => call.args)).toEqual([{ sku: launchInput.sku }]);
    await user.screenshot();
  });

  await step("before: without their own Inventory sign-in, the App asks the person to sign in and never reaches Inventory", async () => {
    await frame?.[Symbol.asyncDispose]();
    frame = undefined;
    await world.disconnectInventory();
    expect(await world.inventorySignedIn()).toBe(false);
    const openedAt = new Date().toISOString();
    await agent.send(signInPrompt);
    await user.see({ text: signInReply }, { timeoutMs: 120_000 });
    await user.see(signInRow, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Sign in" });
    const calculator = await focus();
    await calculator.see({ role: "button", label: "Look up price" }, { timeoutMs: 90_000 });
    await calculator.see({ testId: "order-line" }, { text: orderLine });
    await user.notSee({ text: /needs_connection|connectionStatus/ });
    expect(await world.inventoryCalls({ sinceIso: openedAt })).toEqual([]);
    await user.screenshot();
  });

  await step("after: one click on Sign in completes Inventory's sign-in, and the App reloads with its price", async () => {
    const signedInAt = new Date().toISOString();
    await user.click({ role: "button", label: "Sign in" });
    await probe.eventually(() => world.inventorySignedIn(), { within: 90_000, intervalMs: 1_000, label: "the owner's Inventory sign-in completes", until: signedIn => signedIn });
    await world.returnToOpenWork();
    await user.notSee(signInRow, { timeoutMs: 60_000 });
    await frame?.[Symbol.asyncDispose]();
    frame = await world.appFrameShowing(appTitle, pricedLine);
    await user.on(frame).see({ testId: "order-line" }, { text: pricedLine });
    await user.on(frame).notSee({ role: "button", label: "Look up price" });
    expect((await world.inventoryCalls({ sinceIso: signedInAt, atLeast: 1 })).map(call => call.args)).toEqual([{ sku: launchInput.sku }]);
    await user.screenshot();
  });
});
