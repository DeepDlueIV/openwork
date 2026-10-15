import { createHash } from "node:crypto";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { addConnectorForTeams, mcpConnectionNamed, putMcpConnectionByKey, readManageableMcpConnection, tryConnectorSignIn } from "@openwork/behaviors";
import type { McpConnectionInput } from "@openwork/behaviors";
import { denManageAsAdmin } from "../worlds/den-library-manage.ts";

// The second half of an admin adding connectors (see den-manage-connectors):
// connectors that need a credential only an admin can provide, an API key or
// the admin's own OAuth app, and who can see or replace it.
const test = spec.world(denManageAsAdmin, { timeout: 600_000 });

const names = (items: { name: string }[]) => items.map((item) => item.name);
type Person = "sam" | "maya" | "ana" | "lee" | "noor" | "omar" | "tess" | "kai";
const addPath = "/dashboard/mcp-connections/new";

test("an admin adds a connector that takes an API key, and a member sees that only an admin can", async ({ world, user, probe, step }) => {
  const libraryOf = async (person: Person) => names(await world.library(world.den.members[person]));
  const key = `keyed-docs-${Date.now()}`;
  const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 12);

  await step("before: a member adding it in My Library sees that an admin adds the key", async () => {
    const member = await world.openAs("sam", "/dashboard/library/connectors/new/keyed-docs");
    const sam = user.on(member);
    await sam.see({ role: "heading", label: "Connect Keyed Docs" }, { timeoutMs: 90_000 });
    await sam.see({ testId: "setup-check-sign-in-method" }, { text: /An admin adds the key for Keyed Docs\./, timeoutMs: 60_000 });
    expect((await probe.on(member).dom('[data-testid="setup-check-sign-in-method"][data-status="blocked"]')).elements).toHaveLength(1);
    await sam.notSee({ label: "API key" });
    await sam.screenshot();
  });

  await step("when I add it in Manage and paste the key, every check passes and the key is shared", async () => {
    await user.navigate(`${world.den.ref.webUrl}${addPath}`);
    await user.click({ role: "link", label: "Add Keyed Docs" });
    await user.see({ label: "API key" }, { timeoutMs: 60_000 });
    expect((await probe.dom('[data-testid="setup-check-sign-in-method"][data-status="current"]')).elements).toHaveLength(1);
    await user.notSee({ role: "button", label: "Sign in with Keyed Docs" });
    await user.type({ label: "API key" }, key);
    await user.click({ role: "button", label: "Save key" });
    await user.see({ role: "heading", label: "Keyed Docs passed all 4 checks" }, { timeoutMs: 120_000 });
    await user.see({ text: "Everyone uses the Keyed Docs API key you added." });
    expect((await probe.dom('input[name="sign-in-mode"][value="shared"]:checked:disabled')).elements).toHaveLength(1);
    expect(await mcpConnectionNamed(world.den.admin, "manageable", "Keyed Docs")).toMatchObject({ authType: "apikey", credentialMode: "shared" });
    const calls = await probe.eventually(async () => (await world.keyed.requests()).filter((entry) => entry.path === "/mcp" && entry.tokenId === fingerprint), {
      within: 30_000, label: "the key to reach the server", until: (entries) => entries.length > 0,
    });
    expect(calls.length, "Keyed Docs received the admin's key").toBeGreaterThan(0);
    await user.screenshot();
  });

  await step("after: I give it to Sales; Sales gets it and Kai does not", async () => {
    await addConnectorForTeams(user, "Keyed Docs", ["Sales"]);
    for (const person of ["omar", "tess"] as const) expect(await libraryOf(person), `${person} is in Sales`).toContain("Keyed Docs");
    expect(await libraryOf("kai")).not.toContain("Keyed Docs");
    await user.screenshot();
  });

  await step("the admin rotates the shared key from the connector's own page and it is never returned", async () => {
    const saved = await mcpConnectionNamed(world.den.admin, "manageable", "Keyed Docs");
    if (typeof saved?.id !== "string") throw new Error("Keyed Docs was not saved.");
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections/${encodeURIComponent(saved.id)}`);
    await user.see({ role: "heading", label: "Keyed Docs" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Settings" });
    await user.type({ testId: "connector-settings-api-key" }, "rotated-shared-test-key");
    await user.click({ role: "button", label: "Save changes" });
    await user.see({ testId: "den-toast" }, { text: /Keyed Docs is saved/, timeoutMs: 60_000 });
    await user.see({ testId: "connector-settings-api-key" }, { value: "" });
    const rotated = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    expect(await readManageableMcpConnection(world.den.admin, saved.id)).toMatchObject({ authType: "apikey", credentialMode: "shared" });
    expect(rotated.text).not.toContain("rotated-shared-test-key");
    await user.screenshot();
  });

  await step("a member cannot replace a connector an admin provisioned by its key, and it stays as the admin left it", async () => {
    const externalKey = `provisioned-notes-${Date.now()}`;
    const input: McpConnectionInput = { name: "Provisioned Notes", url: world.custom.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } };
    const created = await putMcpConnectionByKey(world.den.admin, world.organizationId, externalKey, input);
    expect(created.response.status, created.text).toBe(201);
    const id = (await mcpConnectionNamed(world.den.admin, "manageable", "Provisioned Notes"))?.id;
    if (typeof id !== "string") throw new Error("The provisioned connector is missing.");
    const denied = await putMcpConnectionByKey(world.den.members.sam, world.organizationId, externalKey, { ...input, name: "Sam's Notes" });
    expect(denied.response.status, denied.text).toBe(403);
    expect(await readManageableMcpConnection(world.den.admin, id)).toMatchObject({ id, name: "Provisioned Notes", externalKey });
  });
});

test("an admin adds a connector that needs their own OAuth app", async ({ world, user, step }) => {
  const libraryOf = async (person: Person) => names(await world.library(world.den.members[person]));
  const clientId = "team-wiki-client";

  await step("before: step two asks for the OAuth app instead of trying to sign in", async () => {
    await user.navigate(`${world.den.ref.webUrl}${addPath}`);
    await user.click({ role: "link", label: "Add Team Wiki" });
    await user.see({ label: "Client ID" }, { timeoutMs: 60_000 });
    await user.see({ placeholder: "Client secret (optional)" });
    await user.notSee({ role: "button", label: "Sign in with Team Wiki" });
    await user.screenshot();
  });

  await step("when I save the app, sign-in uses it and every check passes", async () => {
    await user.type({ label: "Client ID" }, clientId);
    await user.click({ role: "button", label: "Save app" });
    await tryConnectorSignIn(user, "Team Wiki", () => world.closeSignInTab());
    const authorize = (await world.wiki.requests()).filter((entry) => entry.path === "/authorize");
    expect(authorize.some((entry) => new URL(entry.url, "http://mock.invalid").searchParams.get("client_id") === clientId), "sign-in used the admin's OAuth app").toBe(true);
    await user.screenshot();
  });

  await step("after: I add it for Support and the saved connection keeps the OAuth app", async () => {
    await addConnectorForTeams(user, "Team Wiki", ["Support"]);
    expect(await mcpConnectionNamed(world.den.admin, "manageable", "Team Wiki")).toMatchObject({ authType: "oauth", oauthClientId: clientId });
    expect(await libraryOf("kai")).not.toContain("Team Wiki");
    await user.screenshot();
  });
});
