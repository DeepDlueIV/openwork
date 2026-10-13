import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectorReadiness } from "../worlds/connector-readiness.ts";
import { isRecord } from "../worlds/library.ts";

const test = spec.world(connectorReadiness, { timeout: 600_000, resources: { surfaces: ["web", "appWeb"], services: ["den", "mock"] } });

test("an admin checks a connection and a teammate sees the recorded result without permission to check it", async ({ world, user: driver, agent, probe, step, evidence }) => {
  const user = driver.on(world.web);
  await step("before: a connection saved through the API is checked on save and shows Ready with its time", async () => {
    await user.see({ testId: "admin-connectors" }, { text: /Team Notes/, timeoutMs: 120_000 });
    await user.see({ text: /^Ready$/ }, { timeoutMs: 60_000 });
    await user.see({ text: /^Checked / });
    const saved = await world.saved();
    expect(saved?.readiness).toMatchObject({ status: "ready", reason: null });
    expect(isRecord(saved?.readiness) && typeof saved.readiness.checkedAt === "string").toBe(true);
    const handshakes = await world.den.mocks.notes.handshakes({ atLeast: 1, timeoutMs: 10_000 });
    expect(handshakes.length).toBeGreaterThan(0);
    expect(await world.den.mocks.notes.toolCalls()).toHaveLength(0);
    evidence.recordAssertionEvidence("Ready comes from a stored successful probe, not a tool execution", `${handshakes.length} MCP handshakes; no tool calls; ${JSON.stringify(saved?.readiness)}`, true);
    await user.screenshot();
  });
  await step("a broken server says Couldn't verify instead of keeping Ready", async () => {
    await world.breakServer();
    await user.click({ role: "button", label: "More for Team Notes" });
    await user.click({ text: "Check again" });
    await user.see({ text: "Couldn't verify" }, { timeoutMs: 60_000 });
    await user.see({ text: "Service unavailable. Try again." });
    const saved = await world.saved();
    expect(saved?.readiness).toMatchObject({ status: "could_not_verify" });
    evidence.recordAssertionEvidence("the failed check is stored with a recovery reason", JSON.stringify(saved?.readiness), true);
    await user.screenshot();
  });
  await step("the connection state and Check again remain visible on a narrow screen", async () => {
    await user.resizeViewport({ width: 320, height: 800, deviceScaleFactor: 1 });
    await user.see({ text: "Couldn't verify" });
    await user.see({ role: "button", label: "Check again" });
    evidence.recordAssertionEvidence("readiness does not disappear with the wide status column", "320px viewport; Couldn't verify and Check again are visible", true);
    await user.screenshot();
    await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  });
  await step("a teammate sees the failed check but cannot run it", async () => {
    const member = user.on(world.memberWeb);
    await member.reload();
    await member.see({ text: "Couldn't verify" }, { timeoutMs: 60_000 });
    const disabled = await probe.on(world.memberWeb).dom('button[disabled]');
    expect(disabled.elements.some((item) => item.text === "Check again")).toBe(true);
    const denied = await world.refuseMemberCheck();
    expect(denied.response.status).toBe(403);
    evidence.recordAssertionEvidence("a member can read the state but cannot trigger checks", `Disabled Check again; POST check returned ${denied.response.status}`, true);
    await member.screenshot();
  });
  await step("after: fixing the server and choosing Check again restores Ready", async () => {
    await world.fixServer();
    await user.click({ role: "button", label: "Check again" });
    await user.see({ text: /^Ready$/ }, { timeoutMs: 60_000 });
    const saved = await world.saved();
    expect(saved?.readiness).toMatchObject({ status: "ready" });
    const handshakes = await world.den.mocks.notes.handshakes({ atLeast: 1, timeoutMs: 10_000 });
    expect(handshakes.length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("the real mock answered the stored successful check", `${handshakes.length} MCP handshakes; ${JSON.stringify(saved?.readiness)}`, true);
    await user.screenshot();
  });
  await step("the desktop Library shows the same stored Ready and check time", async () => {
    const appUser = driver.on(world.app);
    await appUser.reload();
    await agent.on(world.app).run("route.extensions.skills");
    await appUser.click({ role: "button", label: "All" });
    await appUser.see({ text: "Team Notes" }, { timeoutMs: 90_000 });
    const appProbe = probe.on(world.app);
    // The row's state sits beside its button; the recorded check time is the row's description.
    const read = async () => ({
      status: (await appProbe.dom('[data-library-row="Team Notes"] + [data-library-status]')).elements[0]?.text.trim() ?? "",
      note: (await appProbe.dom('[data-library-row="Team Notes"] [data-library-description]')).elements[0]?.text.trim() ?? "",
    });
    const state = await appProbe.eventually(read, {
      within: 60_000, label: "Library's recorded check", until: (row) => row.status === "Ready" && row.note.startsWith("Checked "),
    });
    expect(state.status).toBe("Ready");
    expect(state.note).toMatch(/^Checked /);
    evidence.recordAssertionEvidence("Library does not infer readiness from authentication", `status "${state.status}"; note "${state.note}"`, true);
    await appUser.screenshot();
  });
  await step("finishing setup records a server check without another manual action", async () => {
    const address = `${world.upstream.ref.webUrl}/mcp`;
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections/new/custom?${new URLSearchParams({ url: address, name: "Reference Notes" })}`);
    await user.see({ role: "heading", label: "Reference Notes passed all 4 checks" }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Add Reference Notes" });
    await user.see({ testId: "admin-connectors" }, { text: /Reference Notes/, timeoutMs: 60_000 });
    const saved = await world.saved("Reference Notes");
    expect(saved?.readiness).toMatchObject({ status: "ready" });
    evidence.recordAssertionEvidence("setup completion retains a successful server probe", JSON.stringify(saved?.readiness), true);
    await user.screenshot();
  });
});
