import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { BACKUP_PROMPT, CONNECT_PROMPT, GATEWAY_PROMPT, VERTEX_PROMPT, secureKeysInChat } from "../worlds/secure-keys-in-chat.ts";

const test = spec.world(secureKeysInChat, {
  timeout: 900_000,
  resources: { surfaces: ["appWeb", "web"], services: ["den", "mock"] },
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

test("an admin adds a key-protected service and an AI Gateway provider by entering keys privately in chat", async ({ world, user, probe, step, evidence }) => {
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
    evidence.recordAssertionEvidence("The agent created the connection with no key; the field is the host's own", `1 key card in the conversation; connection saved, not connected; destination ${world.statusUrl}`, cards.length === 1);
    await user.screenshot();
  });

  await step("the same field in dark mode", async () => {
    await world.colorScheme("dark");
    await user.see({ text: "Add the API key for Status service" });
    await user.screenshot();
    await world.colorScheme("light");
  });

  await step("the agent cannot send a key itself", async () => {
    const attempt = await world.agentMcp("execute_capability", { name: "postMcpConnections", body: { name: "Smuggled", url: world.statusUrl, authType: "apikey", credentialMode: "shared", apiKey: world.keys.wrong, access: { orgWide: true } } });
    const code = isRecord(attempt.body) ? attempt.body.error : null;
    expect(code).toBe("secure_entry_required");
    expect(attempt.text.includes(world.keys.wrong)).toBe(false);
    evidence.recordAssertionEvidence("A key in an agent call is refused, not stored or repeated", `execute_capability postMcpConnections with apiKey → ${String(code)}; key absent from the reply`, code === "secure_entry_required");
  });

  await step("typing keeps the key hidden; it shows only while typing and asked for", async () => {
    await user.type(keyField, world.keys.wrong, { sensitive: true });
    expect((await probe.dom(`${card} input[type="password"]`)).elements).toHaveLength(1);
    await user.click({ role: "button", label: "Show while typing" });
    expect((await probe.dom(`${card} input[type="text"]`)).elements).toHaveLength(1);
    await user.click({ role: "button", label: "Hide" });
    expect((await probe.dom(`${card} input[type="password"]`)).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("The key is masked by default and revealed only on request", "password → text after Show while typing → password after Hide", true);
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
    evidence.recordAssertionEvidence("The service refused the wrong key; Den did not keep it", `${rejected.length} refused request(s) carried the wrong key's fingerprint; connection still not connected; key absent from the page`, rejected.length > 0);
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
    evidence.recordAssertionEvidence("The status tool ran with the key the person typed", `${accepted.length} accepted request(s) with the typed key's fingerprint, including tools/call; reply: ${world.proof}`, accepted.length > 0);
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
    evidence.recordAssertionEvidence("No key in the page, any model request, or Den's service log", `${calls.length} model requests checked, ${modelSaw} contained a key; page and log: ${leaks} matches`, modelSaw === 0 && leaks === 0);
  });

  await step("a member without Manage connections cannot change the shared key", async () => {
    const created = await world.connection();
    const id = isRecord(created) ? created.id : null;
    if (typeof id !== "string") throw new Error("Missing connection");
    const attempt = await world.memberSavesSharedKey(id);
    expect(attempt.response.status).toBe(403);
    expect(attempt.text.includes(world.keys.wrong)).toBe(false);
    evidence.recordAssertionEvidence("Only people with Manage connections enter the shared key", `Member save → HTTP ${attempt.response.status}`, attempt.response.status === 403);
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
    evidence.recordAssertionEvidence("The provider's shared key is set for everyone without reaching the agent", `Shared credential set ready; key absent from provider details; ${modelSaw} model requests contained it`, ready && modelSaw === 0);
    await user.screenshot();
  });

  await step("a Google Cloud provider asks for its key file the same way, masked until shown", async () => {
    await world.scriptVertex();
    await user.type("composer", VERTEX_PROMPT, { replace: true, verify: true });
    await user.click({ role: "button", label: "Run task" });
    await user.see({ text: "Add the credentials for Team Vertex" }, { timeoutMs: 120_000 });
    await user.see({ text: "Paste the service account key in the field above and I'll finish." }, { timeoutMs: 60_000 });
    await user.type({ label: "Service account key (JSON)" }, world.serviceAccount, { sensitive: true });
    await user.screenshot();
    await user.click({ role: "button", label: "Save credentials" });
    await user.see({ text: "Team Vertex: credentials saved" }, { timeoutMs: 60_000 });
    await user.see({ text: "Team Vertex is ready for everyone." }, { timeoutMs: 120_000 });
    const provider = await world.providerByName("Team Vertex");
    const sets = isRecord(provider?.body) && isRecord(provider.body.inferenceProvider) ? provider.body.inferenceProvider.credentialSets : null;
    const ready = Array.isArray(sets) && sets.some((set) => isRecord(set) && set.credentialMode === "org" && set.credentialStatus === "ready");
    const modelSaw = (await world.mock.agentRequests()).filter((call) => call.privateSentinelSeen).length;
    expect(ready).toBe(true);
    expect(modelSaw).toBe(0);
    expect((await probe.text()).includes(world.serviceAccount)).toBe(false);
    evidence.recordAssertionEvidence("A service-account key file is saved for everyone without reaching the agent", `Shared credential set ready; ${modelSaw} model requests contained the key; key file absent from the page`, ready && modelSaw === 0);
    await user.screenshot();
  });

  await step("agents cannot send keys to custom LLM providers either", async () => {
    const attempt = await world.agentMcp("execute_capability", { name: "postLlmProviders", body: { name: "Smuggled provider", providerId: "openai", apiKey: world.keys.wrong } });
    const code = isRecord(attempt.body) ? attempt.body.error : null;
    expect(code).toBe("secure_entry_required");
    expect(attempt.text.includes(world.keys.wrong)).toBe(false);
    evidence.recordAssertionEvidence("Custom LLM provider keys from an agent are refused", `execute_capability postLlmProviders with apiKey → ${String(code)}`, code === "secure_entry_required");
  });

  await step("OpenWork Cloud shows the saved key as a Replace row and the same private field", async () => {
    const admin = user.on(world.web);
    const provider = await world.providerByName("Team OpenRouter");
    if (!provider) throw new Error("Missing provider");
    await admin.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway/providers/${encodeURIComponent(provider.id)}/edit`);
    await admin.see({ testId: "gateway-provider-replace-key" }, { timeoutMs: 90_000 });
    await admin.see({ text: "••••••••" });
    await admin.screenshot();
    await admin.click({ testId: "gateway-provider-replace-key" });
    await admin.see({ role: "button", label: "Show while typing" });
    await admin.screenshot();
    await admin.click({ role: "button", label: "Cancel" });
    await admin.see({ testId: "gateway-provider-replace-key" });
    evidence.recordAssertionEvidence("The dashboard uses the same saved row and private field", "Saved key shows ••••••••; Replace opens a masked field with Show while typing; Cancel restores the saved row", true);
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
    await user.see({ text: "Team Vertex: credentials saved" });
    const status = await world.connection();
    expect(isRecord(status) && status.connected).toBe(true);
    expect((await probe.dom(`${card} input`)).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Turning the rollout off restores the dashboard path", `Agent: "${message.slice(0, 80)}"; the pending card links to OpenWork Cloud with no field; Team Vertex still reads as saved and Status service stays connected`, true);
    await user.screenshot();
  });
});
