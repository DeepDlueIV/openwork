import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { addTeamsToAccess, mcpConnectionNamed, requestMcpConnectionCheck, saveMcpConnection, startMcpConnectionSignIn, tamperedMcpSignInReplies, tryConnectorSignIn } from "@openwork/behaviors";
import { denManageAsAdmin } from "../worlds/den-library-manage.ts";

// Admins add a connector once in Manage and choose who gets it. Every add
// happens on full pages: the catalog, the setup checks, then who can use it.
// How a connector authenticates (API key, the admin's own OAuth app) is in
// den-manage-connectors-credentials.
const test = spec.world(denManageAsAdmin, { timeout: 600_000 });

const names = (items: { name: string }[]) => items.map((item) => item.name);
type Person = "sam" | "maya" | "ana" | "lee" | "noor" | "omar" | "tess" | "kai";
const addPath = "/dashboard/mcp-connections/new";
const sidebarBadges = '[data-testid="den-org-sidebar"] a[href$="/mcp-connections"] [data-testid="nav-badge"]';

test("an admin adds a listed connector for two teams, and removes it without surprises", async ({ world, user, probe, step }) => {
  const libraryOf = async (person: Person) => names(await world.library(world.den.members[person]));
  const reach = world.teamSize("Sales") + world.teamSize("Support");

  await step("1. I open Connectors in Manage: nothing is set up yet, and the item keeps its MCPs badge", async () => {
    await user.see({ testId: "connectors-empty" }, { timeoutMs: 120_000 });
    await user.see({ text: "Apps your organization's AI can use. You choose who gets each one." });
    await user.see({ text: "Members can still add apps for themselves in My Library." });
    const links = await probe.eventually(() => world.sidebarLinks(), {
      within: 30_000, label: "admin sidebar", until: (labels) => labels.some((label) => label.startsWith("Connectors")),
    });
    for (const label of ["My Library", "Plugins", "Members", "ConnectorsMCPs"]) expect(links).toContain(label);
    expect((await probe.dom(sidebarBadges)).elements.map((badge) => badge.text)).toEqual(["MCPs"]);
    await user.screenshot();
  });

  await step("2. I choose Add connector and pick Slack", async () => {
    await user.click({ role: "link", label: "Add connector" });
    await user.see({ role: "heading", label: "Add a connector" }, { timeoutMs: 60_000 });
    await user.click({ role: "link", label: "Add Slack" });
    await user.see({ role: "heading", label: "Add Slack" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Sign in with Slack" }, { timeoutMs: 60_000 });
    expect(await world.servedPinnedCatalog(), "the catalog and checks came from the mock, not a real provider").toBe(true);
    await user.screenshot();
  });

  await step("3. I sign in with Slack once to try it: each person signs in by default", async () => {
    await tryConnectorSignIn(user, "Slack", () => world.closeSignInTab());
    await user.see({ role: "radio", label: /Each person signs in/ });
    expect((await probe.dom('input[name="sign-in-mode"][value="per_member"]:checked')).elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("4. I give it to Sales and Support and add it", async () => {
    await addTeamsToAccess(user, ["Sales", "Support"]);
    await user.see({ testId: "step-footer-note" }, { text: `${reach} people will find Slack in My Library.` });
    await user.click({ role: "button", label: "Add Slack" });
    await user.see({ testId: "den-toast" }, { text: new RegExp(`Slack is ready[\\s\\S]*${reach} people will find it in My Library\\.`), timeoutMs: 60_000 });
    await user.see({ testId: "admin-connectors" }, { text: /Slack[\s\S]*Ready/, timeoutMs: 60_000 });
    await user.screenshot();
  });

  await step("5. I open Slack: who can use it sits on the page instead of a Share button", async () => {
    await user.click({ role: "link", label: /^Slack/ });
    await user.see({ testId: "admin-connector-page" }, { timeoutMs: 60_000 });
    await user.see({ text: "Each person signs in with their own Slack account" });
    const teams = (await probe.dom('[data-testid="access-team"]')).elements.map((row) => /^(Sales|Support)/.exec(row.text)?.[1]).sort();
    expect(teams, "both teams sit in Who can use it").toEqual(["Sales", "Support"]);
    await user.notSee({ role: "link", label: "Share" });
    await user.see({ role: "button", label: "Use in another app" });
    await user.see({ role: "button", label: "Settings" });
    await user.screenshot();
  });

  await step("after: Sales and Support find Slack and sign in as themselves; Kai does not have it, and a member cannot re-run its checks", async () => {
    for (const person of ["omar", "tess", "ana", "lee", "noor"] as const) {
      expect(await libraryOf(person), `${person} has Slack`).toContain("Slack");
      expect((await mcpConnectionNamed(world.den.members[person], "usable", "Slack"))?.credentialMode, `${person} signs in with their own account`).toBe("per_member");
    }
    expect(await libraryOf("kai"), "Kai is in neither team").not.toContain("Slack");
    const slack = await mcpConnectionNamed(world.den.admin, "manageable", "Slack");
    if (typeof slack?.id !== "string") throw new Error("Slack was not saved.");
    expect(await requestMcpConnectionCheck(world.den.members.omar, slack.id), "only an admin runs Check again").toBe(403);
  });

  await step("after: Remove asks first and Cancel keeps Slack; confirming removes it from everyone's Library", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections`);
    await user.click({ role: "button", label: "More for Slack" });
    await user.click({ role: "menuitem", label: "Remove" });
    await user.see({ testId: "confirm-dialog" }, { text: /Remove Slack\?/ });
    await user.see({ text: "Nobody can use it anymore. This cannot be undone." });
    await user.screenshot();
    await user.click({ testId: "confirm-dialog-cancel" });
    await probe.eventually(() => probe.dom('[data-testid="confirm-dialog"]'), { within: 10_000, label: "the dialog closed", until: (found) => found.elements.length === 0 });
    await user.see({ testId: "admin-connectors" }, { text: /Slack/ });
    expect(await libraryOf("omar"), "Cancel keeps Slack").toContain("Slack");
    await user.click({ role: "button", label: "More for Slack" });
    await user.click({ role: "menuitem", label: "Remove" });
    await user.click({ role: "button", label: "Remove" });
    await user.see({ testId: "den-toast" }, { text: /Slack is removed/, timeoutMs: 60_000 });
    await user.see({ testId: "connectors-empty" }, { timeoutMs: 60_000 });
    for (const person of ["omar", "ana"] as const) expect(await libraryOf(person), `${person} lost Slack`).not.toContain("Slack");
    await user.screenshot();
  });
});

test("an admin: I want to add an MCP that isn't in the catalog", async ({ world, user, probe, step }) => {
  const libraryOf = async (person: Person) => names(await world.library(world.den.members[person]));
  const address = world.custom.mcpUrl;
  const host = new URL(address).host;
  const name = "Team Notes";

  await step("before: the add page lists known connectors with Google Workspace and Microsoft 365, and a quiet Add another MCP", async () => {
    await user.navigate(`${world.den.ref.webUrl}${addPath}`);
    await user.see({ role: "heading", label: "Add a connector" }, { timeoutMs: 60_000 });
    for (const label of ["Add HubSpot", "Add Google Workspace", "Add Microsoft 365"]) await user.see({ role: "link", label }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Add another MCP" });
    await user.notSee({ text: /Advanced setup/ });
    await user.screenshot();
  });

  await step("when I paste an address into the filter, it shows up as an MCP server to add", async () => {
    await user.type({ placeholder: "Filter by name" }, address);
    await user.see({ testId: "connector-picker-url-row" }, { text: new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await user.see({ testId: "connector-picker-url-add" }, { text: "Add MCP" });
    await user.see({ testId: "connector-picker-url-no-match" }, { text: "No catalog connectors match this address." });
    await user.screenshot();
    await user.type({ placeholder: "Filter by name" }, "", { replace: true });
  });

  await step("Add another MCP opens the address form on the same page, and the setup page checks the server", async () => {
    await user.click({ role: "button", label: "Add another MCP" });
    await user.see({ testId: "connector-picker-custom" }, { timeoutMs: 30_000 });
    await user.notSee({ testId: "add-mcp-connection-dialog" });
    expect(await world.location()).toBe(addPath);
    await user.type({ label: "Address" }, address);
    await user.type({ label: "Name" }, name);
    await user.click({ role: "button", label: "Continue" });
    await user.see({ role: "heading", label: `Add ${name}` }, { timeoutMs: 60_000 });
    const setupUrl = new URL(await world.location(), world.den.ref.webUrl);
    expect(setupUrl.pathname).toBe(`${addPath}/custom`);
    expect(setupUrl.searchParams.get("url")).toBe(address);
    await tryConnectorSignIn(user, name, () => world.closeSignInTab());
    await user.screenshot();
  });

  await step("after: I give it to Support; Support finds it in My Library, and Sales and Kai do not", async () => {
    await addTeamsToAccess(user, ["Support"]);
    await user.see({ testId: "step-footer-note" }, { text: `${world.teamSize("Support")} people will find ${name} in My Library.` });
    await user.click({ role: "button", label: `Add ${name}` });
    await user.see({ testId: "den-toast" }, { text: new RegExp(`${name} is ready`), timeoutMs: 60_000 });
    await user.see({ testId: "admin-connectors" }, { text: new RegExp(name), timeoutMs: 60_000 });
    expect((await mcpConnectionNamed(world.den.admin, "manageable", name))?.url).toBe(address);
    for (const person of ["ana", "lee", "noor"] as const) expect(await libraryOf(person), `${person} is in Support`).toContain(name);
    for (const person of ["omar", "tess", "kai"] as const) expect(await libraryOf(person), `${person} is not`).not.toContain(name);
    await user.screenshot();
  });

  await step("a sign-in reply with the wrong issuer or a forged state is refused before Den asks for a token, and the genuine reply works only once", async () => {
    const issuer = world.oauthBoundaries?.issuer;
    if (!issuer) throw new Error("This journey needs the OAuth boundary servers from the world.");
    const id = await saveMcpConnection(world.den.admin, { name: "Issuer Notes", url: issuer.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true } });
    const replies = await tamperedMcpSignInReplies(world.den.admin, id, issuer);
    expect(replies.issuerNamed, "the provider names itself on every reply").toBe(true);
    for (const tampered of [replies.wrongIssuer, replies.forgedState]) {
      expect(tampered.status).toBeGreaterThanOrEqual(400);
      expect(tampered).toMatchObject({ tokenRequests: 0, connected: false });
    }
    expect(replies.genuine).toEqual({ status: 200, tokenRequests: 1, connected: true });
    expect(replies.replay.status).toBeGreaterThanOrEqual(400);
    expect(replies.replay).toMatchObject({ tokenRequests: 0, connected: true });
  });

  await step("Den refuses to sign in to a server that claims a protected resource on another site", async () => {
    const foreign = world.oauthBoundaries?.foreignResource;
    if (!foreign) throw new Error("This journey needs the OAuth boundary servers from the world.");
    const id = await saveMcpConnection(world.den.admin, { name: "Lookalike Notes", url: foreign.mcpUrl, authType: "oauth", credentialMode: "shared", access: { orgWide: true } });
    const started = await startMcpConnectionSignIn(world.den.admin, id);
    expect(started.status, started.text).not.toBe(200);
    expect(started.authorizeUrl, "no sign-in link for a token meant for another site").toBeNull();
    expect((await foreign.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token")).toEqual([]);
  });
});
