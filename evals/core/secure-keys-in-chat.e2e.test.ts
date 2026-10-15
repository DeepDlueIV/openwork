import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { callMcpTool, createPersonalKeyConnection, createTeamWith, memberIdByEmail, mintMcpToken, myConnectionRow, readMyConnectionKey, saveMyConnectionKey, setTeamMembers, type McpToolResult } from "@openwork/behaviors";
import { BACKUP_PROMPT, CONNECT_PROMPT, GATEWAY_PROMPT, secureKeysInChat } from "../worlds/secure-keys-in-chat.ts";

const test = spec.world(secureKeysInChat, {
  timeout: 900_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const card = '[data-testid="credential-prompt-card"]';
const keyField = { label: "API key" };

/** Text inside the card's one state line, which also names the audience. */
function within(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The gateway refused the call, either as a tool error or a JSON-RPC error. */
function refused(result: McpToolResult): boolean {
  return result.isError || result.rpcError !== null;
}

test("an admin adds a key-protected service and an AI Gateway provider by entering keys privately in chat", async ({ world, user, probe, step }) => {
  await step("before: the agent sets up the service without its key and a private field appears in the chat", async () => {
    await world.scriptConnection();
    await user.type("composer", CONNECT_PROMPT, { verify: true });
    await user.click({ role: "button", label: "Run task" });
    await user.see({ text: "Add the API key for Status service" }, { timeoutMs: 120_000 });
    await user.see({ text: "Add the key in the field above and I'll continue." }, { timeoutMs: 60_000 });
    await user.see({ text: within(`sent only to ${world.statusUrl}`) });
    const cards = (await probe.dom(card)).elements;
    expect(cards).toHaveLength(1);
    const created = await world.connection();
    expect(isRecord(created) && created.connected).toBe(false);
    await user.screenshot();
  });

  await step("the agent cannot send a key itself, to a connection or to a custom LLM provider", async () => {
    const smuggled: { name: string; body: Record<string, unknown> }[] = [
      { name: "postMcpConnections", body: { name: "Smuggled", url: world.statusUrl, authType: "apikey", credentialMode: "shared", apiKey: world.keys.wrong, access: { orgWide: true } } },
      { name: "postLlmProviders", body: { name: "Smuggled provider", providerId: "openai", apiKey: world.keys.wrong } },
    ];
    for (const { name, body } of smuggled) {
      const attempt = await world.agentMcp("execute_capability", { name, body });
      expect(isRecord(attempt.body) ? attempt.body.error : null, name).toBe("secure_entry_required");
      expect(attempt.text.includes(world.keys.wrong)).toBe(false);
    }
  });

  await step("typing keeps the key hidden; it shows only while typing and asked for", async () => {
    await user.type(keyField, world.keys.wrong, { sensitive: true });
    expect((await probe.dom(`${card} input[type="password"]`)).elements).toHaveLength(1);
    await user.click({ role: "button", label: "Show while typing" });
    expect((await probe.dom(`${card} input[type="text"]`)).elements).toHaveLength(1);
    await user.click({ role: "button", label: "Hide" });
    expect((await probe.dom(`${card} input[type="password"]`)).elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("a key the service rejects is not kept and never repeated", async () => {
    await user.click({ role: "button", label: "Save key" });
    await user.see({ text: "Status service didn't accept this key. Check it and try again." }, { timeoutMs: 60_000 });
    expect((await probe.text()).includes(world.keys.wrong)).toBe(false);
    const rejected = world.wire.filter((entry) => entry.identity === world.fingerprint(world.keys.wrong) && entry.status === 401);
    expect(rejected.length).toBeGreaterThan(0);
    const after = await world.connection();
    expect(isRecord(after) && after.connected).toBe(false);
    await user.screenshot();
  });

  await step("after: the right key is saved, the agent continues on its own and the service answers", async () => {
    await user.type(keyField, world.keys.status, { sensitive: true });
    await user.click({ role: "button", label: "Save key" });
    await user.see({ text: "Status service: key saved" }, { timeoutMs: 60_000 });
    await user.see({ text: world.proof }, { timeoutMs: 120_000 });
    const accepted = world.wire.filter((entry) => entry.identity === world.fingerprint(world.keys.status) && entry.status === 200);
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.some((entry) => entry.method === "tools/call")).toBe(true);
    await user.screenshot();
  });

  await step("the key never reached the transcript, the model, or Den's log", async () => {
    const page = await probe.text();
    const calls = await world.mock.agentRequests();
    const log = await world.den.apiLog();
    const leaks = [page, log].filter((text) => [world.keys.status, world.keys.wrong].some((key) => text.includes(key))).length;
    const modelSaw = calls.filter((call) => call.privateSentinelSeen).length;
    expect(calls.length).toBeGreaterThan(0);
    expect(modelSaw).toBe(0);
    expect(leaks).toBe(0);
  });

  await step("a member without Manage connections cannot change the shared key", async () => {
    const created = await world.connection();
    const id = isRecord(created) ? created.id : null;
    if (typeof id !== "string") throw new Error("Missing connection");
    const attempt = await world.memberSavesSharedKey(id);
    expect(attempt.response.status).toBe(403);
    expect(attempt.text.includes(world.keys.wrong)).toBe(false);
  });

  await step("with individual keys, each call carries only the caller's own key and nobody can read a key back", async () => {
    const scope = { organizationId: world.organizationId };
    const riley = world.den.members.riley;
    if (!riley) throw new Error("Missing member");
    const url = new URL("/personal/mcp", world.statusUrl).toString();
    const sentSince = (start: number) => world.wire.slice(start).filter((entry) => entry.path.startsWith("/personal"));
    const id = await createPersonalKeyConnection(world.den.admin, { name: "Personal status service", url, access: { orgWide: true } }, scope);
    const capability = { name: `mcp:${id}:team_status`, body: {} };
    expect((await saveMyConnectionKey(world.den.admin, id, world.keys.status, scope)).response.status).toBe(200);
    const adminStart = world.wire.length;
    expect((await world.agentMcp("execute_capability", capability)).isError).toBe(false);
    expect(sentSince(adminStart).some((entry) => entry.method === "tools/call" && entry.status === 200 && entry.identity === world.fingerprint(world.keys.status))).toBe(true);

    // Riley can use the connection but has no key yet: the owner's key is not lent to her.
    const rileyToken = await mintMcpToken(riley, scope);
    const noKeyStart = world.wire.length;
    const noKey = await callMcpTool(world.den.ref, rileyToken, "execute_capability", capability);
    expect(refused(noKey)).toBe(true);
    expect(sentSince(noKeyStart)).toHaveLength(0);

    expect((await saveMyConnectionKey(riley, id, "x\r\nCookie: y", scope)).response.status).toBe(400);
    const rileyKey = `riley-${crypto.randomUUID()}`;
    expect((await saveMyConnectionKey(riley, id, rileyKey, scope)).response.status).toBe(200);
    const ownStart = world.wire.length;
    const own = await callMcpTool(world.den.ref, rileyToken, "execute_capability", capability);
    expect(refused(own)).toBe(true);
    const ownSent = sentSince(ownStart);
    expect(ownSent.length).toBeGreaterThan(0);
    expect(ownSent.every((entry) => entry.identity === world.fingerprint(rileyKey))).toBe(true);
    expect([rileyKey, world.keys.status].some((key) => own.raw.includes(key))).toBe(false);

    const readBack = await readMyConnectionKey(riley, id, scope);
    expect(readBack.response.status).toBe(404);
    const row = await myConnectionRow(riley, id, scope);
    expect(row).not.toBeNull();
    expect([rileyKey, world.keys.status].some((key) => JSON.stringify(row).includes(key))).toBe(false);

    const ownerId = await memberIdByEmail(world.den.admin, world.den.admin.email, scope);
    const ownerOnly = await createPersonalKeyConnection(world.den.admin, { name: "Owner-only status service", url, access: { orgWide: false, memberIds: [ownerId] } }, scope);
    const outsideStart = world.wire.length;
    const outsideSave = await saveMyConnectionKey(riley, ownerOnly, rileyKey, scope);
    expect(outsideSave.response.status).toBe(403);
    expect(refused(await callMcpTool(world.den.ref, rileyToken, "execute_capability", { name: `mcp:${ownerOnly}:team_status`, body: {} }))).toBe(true);
    expect(sentSince(outsideStart)).toHaveLength(0);
  });

  await step("leaving the team that gives a connection removes the person's key from it", async () => {
    const scope = { organizationId: world.organizationId };
    const riley = world.den.members.riley;
    if (!riley) throw new Error("Missing member");
    const sentSince = (start: number) => world.wire.slice(start).filter((entry) => entry.path.startsWith("/team"));
    const rileyId = await memberIdByEmail(world.den.admin, riley.email, scope);
    const teamId = await createTeamWith(world.den.admin, "Status readers", [rileyId], scope);
    const id = await createPersonalKeyConnection(world.den.admin, { name: "Team status service", url: new URL("/team/mcp", world.statusUrl).toString(), access: { orgWide: false, teamIds: [teamId] } }, scope);
    const capability = { name: `mcp:${id}:team_status`, body: {} };
    const rileyToken = await mintMcpToken(riley, scope);
    // Riley's own entry; the witness only accepts this one value.
    expect((await saveMyConnectionKey(riley, id, world.keys.status, scope)).response.status).toBe(200);
    expect(refused(await callMcpTool(world.den.ref, rileyToken, "execute_capability", capability))).toBe(false);

    expect((await setTeamMembers(world.den.admin, teamId, [], scope)).response.status).toBe(200);
    const removedStart = world.wire.length;
    expect(refused(await callMcpTool(world.den.ref, rileyToken, "execute_capability", capability))).toBe(true);
    expect((await saveMyConnectionKey(riley, id, world.keys.status, scope)).response.status).toBe(403);

    expect((await setTeamMembers(world.den.admin, teamId, [rileyId], scope)).response.status).toBe(200);
    expect(refused(await callMcpTool(world.den.ref, rileyToken, "execute_capability", capability))).toBe(true);
    const sent = sentSince(removedStart).length;
    expect(sent).toBe(0);
    const row = await myConnectionRow(riley, id, scope);
    expect(row?.connectedForMe).toBe(false);
  });

  await step("a personal key is never sent on through a redirect or repeated back from a service error", async () => {
    const scope = { organizationId: world.organizationId };
    const moved = await createPersonalKeyConnection(world.den.admin, { name: "Moved status service", url: new URL("/redirect/mcp", world.statusUrl).toString(), access: { orgWide: true } }, scope);
    expect((await saveMyConnectionKey(world.den.admin, moved, world.keys.status, scope)).response.status).toBe(200);
    const movedStart = world.wire.length;
    expect((await world.agentMcp("execute_capability", { name: `mcp:${moved}:team_status`, body: {} })).isError).toBe(true);
    const redirected = world.wire.slice(movedStart).filter((entry) => entry.path.startsWith("/redirect")).length;
    const followed = world.wire.slice(movedStart).filter((entry) => entry.path.startsWith("/followed")).length;
    expect(redirected).toBeGreaterThan(0);
    expect(followed).toBe(0);

    const echoing = await createPersonalKeyConnection(world.den.admin, { name: "Echoing status service", url: new URL("/echo/mcp", world.statusUrl).toString(), access: { orgWide: true } }, scope);
    expect((await saveMyConnectionKey(world.den.admin, echoing, world.keys.status, scope)).response.status).toBe(200);
    const echoStart = world.wire.length;
    const echoed = await world.agentMcp("execute_capability", { name: `mcp:${echoing}:team_status`, body: {} });
    expect(echoed.isError).toBe(true);
    expect(world.wire.slice(echoStart).some((entry) => entry.path.startsWith("/echo") && entry.method === "tools/call")).toBe(true);
    const repeated = echoed.text.includes(world.keys.status) || (await world.den.apiLog()).includes(world.keys.status);
    expect(repeated).toBe(false);
  });

  await step("the admin adds an AI Gateway provider the same way", async () => {
    await world.scriptGateway();
    await user.type("composer", GATEWAY_PROMPT, { replace: true, verify: true });
    await user.click({ role: "button", label: "Run task" });
    await user.see({ text: "Add the API key for Team OpenRouter" }, { timeoutMs: 120_000 });
    await user.see({ text: "Add the OpenRouter key in the field above and I'll finish." }, { timeoutMs: 60_000 });
    await user.see({ text: within("sent only to https://openrouter.ai/api/v1") });
    await user.screenshot();
    const cards = (await probe.dom(`${card}[data-credential-prompt="gateway_provider_key"] input`)).elements;
    expect(cards).toHaveLength(1);
    // The status service's card is saved and has no field, so this is the only one.
    await user.type(keyField, world.keys.gateway, { sensitive: true });
    await user.click({ role: "button", label: "Save key" });
    await user.see({ text: "Team OpenRouter: key saved" }, { timeoutMs: 60_000 });
    await user.see({ text: "Team OpenRouter is ready for everyone." }, { timeoutMs: 120_000 });
    const provider = await world.gatewayProvider();
    const sets = provider ? (isRecord(provider.body) && isRecord(provider.body.inferenceProvider) ? provider.body.inferenceProvider.credentialSets : null) : null;
    const ready = Array.isArray(sets) && sets.some((set) => isRecord(set) && set.credentialMode === "org" && set.credentialStatus === "ready");
    expect(ready).toBe(true);
    expect(provider?.text.includes(world.keys.gateway)).toBe(false);
    const modelSaw = (await world.mock.agentRequests()).filter((call) => call.privateSentinelSeen).length;
    expect(modelSaw).toBe(0);
    await user.screenshot();
  });

  await step("with the rollout off, agents are sent to OpenWork Cloud as before and saved keys stay saved", async () => {
    await world.scriptBackup();
    await user.type("composer", BACKUP_PROMPT, { replace: true, verify: true });
    await user.click({ role: "button", label: "Run task" });
    await user.see({ text: "Add the API key for Backup status service" }, { timeoutMs: 120_000 });
    await user.see({ text: "Add the backup service's key in the field above." }, { timeoutMs: 60_000 });
    await world.setFeature(false);
    const attempt = await world.agentMcp("execute_capability", { name: "postMcpConnections", body: { name: "Another service", url: world.statusUrl, authType: "apikey", credentialMode: "shared", access: { orgWide: true } } });
    const message = isRecord(attempt.body) && typeof attempt.body.message === "string" ? attempt.body.message : "";
    expect(message).toContain("API-key connections cannot be created from the agent");
    await user.reload();
    await user.see({ text: "API key for Backup status service" }, { timeoutMs: 60_000 });
    await user.see({ text: "Adding keys in chat is off for your organization. Use OpenWork Cloud instead." });
    // After a reload only recent turns render; the earlier connection is checked in Den.
    await user.see({ text: "Team OpenRouter: key saved" });
    const status = await world.connection();
    expect(isRecord(status) && status.connected).toBe(true);
    expect((await probe.dom(`${card} input`)).elements).toHaveLength(0);
    await user.screenshot();
  });
});
