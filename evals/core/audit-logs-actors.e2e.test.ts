import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  attemptPasswordSignIn, auditOperationEvents, auditOperations, auditPage, callMcpTool, createOrganizationApiKey, createTeamPermissionSet,
  createTeamWithApiKey, markOrganizationDpaSigned, mintMcpToken, onlyAuditOperationWith, signOutBrowserSession,
} from "@openwork/behaviors";
import type { AuditOperationSummary } from "@openwork/types/den/audit";
import { auditLogs } from "../worlds/audit-logs.ts";

// The second audit journey (filtering is in audit-logs): every kind of actor
// an owner must be able to tell apart, attributed correctly, with no credential.
const test = spec.world(auditLogs, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

test("an owner reads who did what: themselves, a refused teammate, a platform administrator, a script and an MCP client", { timeout: 1_200_000 }, async ({ world, user, probe, step }) => {
  const owner = user.on(world.web);
  const ui = auditPage(owner, probe.on(world.web));
  const setName = `${world.reviewersTeamName} Permissions`;

  await step("the owner gives the Audit reviewers team its own permissions, and finds that change as one operation from one request", async () => {
    await owner.see({ role: "heading", label: "Audit logs" }, { timeoutMs: 90_000 });
    expect((await createTeamPermissionSet(world.den.admin, world.reviewersTeamId, ["audit.view"])).response.status).toBe(201);
    await ui.filter("Permission set created", "permission set created");
    await owner.see({ role: "button", label: "View changes for Permission set create requested" }, { timeoutMs: 30_000 });
    const { operation, events } = await onlyAuditOperationWith(world.den.admin, "permission_set.created");
    expect(operation).toMatchObject({ action: "permission_set.create.requested", origin: "api" });
    expect(events.map((event) => event.action)).toEqual(["permission_set.create.requested", "permission_set.created", "permission_set.create.succeeded"]);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
    expect((await ui.summary(operation.id)).startsWith("Audit Owner ")).toBe(true);
    const created = events.find((event) => event.action === "permission_set.created")?.changes;
    expect(created?.before).toBeNull();
    expect(created?.after).toMatchObject({ name: setName, kind: "team", teamId: world.reviewersTeamId, allowed: ["audit.view"] });
    expect(events.find((event) => event.action === "permission_set.create.succeeded")?.http).toEqual({ method: "POST", route: "/v1/permissions/sets", status: 201 });
    await owner.click({ role: "button", label: "View changes for Permission set create requested" });
    const timeline = await ui.expanded(operation.id, events.length);
    expect(timeline.events[1]?.headline).toBe("Permission set created · Succeeded · Audit Owner");
    expect(timeline.changes).toContain(`Name | None | ${setName}`);
    expect(timeline.changes).toContain("Allowed | None | audit.view");
    await owner.screenshot();
    await owner.click({ role: "button", label: "Hide changes for Permission set create requested" });
  });

  await step("a teammate's refused attempt to create team permissions is a denied security event attributed to the teammate", async () => {
    expect((await createTeamPermissionSet(world.teammate, world.reviewersTeamId, ["audit.view"])).response.status).toBe(403);
    await ui.filter("Permission set create attempted", "permission set create attempted");
    const { operation, events } = await onlyAuditOperationWith(world.den.admin, "permission_set.create.attempted");
    expect(operation.initiatingActor).toMatchObject({ type: "user", id: world.teammateUserId });
    expect(events.find((event) => event.action === "permission_set.create.attempted")).toMatchObject({
      category: "security", outcome: "denied", reasonCode: "request_denied",
      actor: { type: "user", id: world.teammateUserId }, http: { method: "POST", route: "/v1/permissions/sets", status: 403 },
    });
    expect(events.some((event) => event.action === "permission_set.created")).toBe(false);
    expect((await ui.summary(operation.id)).startsWith("Audit Teammate ")).toBe(true);
    await owner.click({ role: "button", label: "View changes for Permission set create requested" });
    const shown = (await ui.expanded(operation.id, events.length)).events.find((event) => event.headline.startsWith("Permission set create attempted"));
    expect(shown?.headline).toBe("Permission set create attempted · Denied · Audit Teammate");
    expect(shown?.text).toContain("Request denied");
    await owner.screenshot();
    await owner.click({ role: "button", label: "Hide changes for Permission set create requested" });
  });

  await step("a platform administrator's DPA change reads Platform administrator, not a member, and keeps no reason text", async () => {
    const reason = "Synthetic countersigned DPA for the audit proof";
    expect((await markOrganizationDpaSigned(world.platformAdmin, world.orgId, reason)).response.status).toBe(200);
    await ui.filter("Organization DPA signed updated", "dpa");
    const { operation, events, text } = await onlyAuditOperationWith(world.den.admin, "organization.dpa_signed.updated");
    expect(operation.origin).toBe("platform_admin");
    expect(operation.initiatingActor.type).toBe("user");
    expect(operation.initiatingActor.memberId).toBeUndefined();
    expect(text).not.toContain(reason);
    expect((await ui.summary(operation.id)).startsWith("Platform administrator ")).toBe(true);
    await owner.click({ role: "button", label: "View changes for Organization DPA update requested" });
    expect((await ui.expanded(operation.id, events.length)).changes).toContain("DPA signed | None | Yes");
    await owner.notSee({ text: reason });
    await owner.screenshot();
  });

  await step("after: a sign-in, a wrong password, a sign-out, an API-key script and an MCP tool call each reach the owner's history with their actor and no credential", async () => {
    const credentials: string[] = [];
    const idsWith = async (action: string) => new Set((await auditOperations(world.den.admin, `&action=${encodeURIComponent(action)}`)).operations.map((operation) => operation.id));
    const newOperation = async (action: string, before: ReadonlySet<string>, matches: (operation: AuditOperationSummary) => boolean) => {
      const found = await probe.eventually(async () => (await auditOperations(world.den.admin, `&action=${encodeURIComponent(action)}`)).operations.filter((operation) => !before.has(operation.id) && matches(operation)), {
        within: 30_000, label: `${action} reaches the owner's audit history`, until: (value) => value.length > 0,
      });
      expect(found).toHaveLength(1);
      const operation = found[0];
      if (!operation) throw new Error(`No new operation recorded ${action}`);
      const { events, text } = await auditOperationEvents(world.den.admin, operation.id);
      const event = events.find((entry) => entry.action === action);
      if (!event) throw new Error(`Operation ${operation.id} has no ${action} event`);
      return { operation, event, text };
    };

    const sessionsBefore = await idsWith("session.created");
    const signedIn = await attemptPasswordSignIn(world.den.ref, { email: world.teammate.email, password: world.teammate.password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.cookie).not.toBe("");
    credentials.push(signedIn.token, signedIn.cookie.slice(signedIn.cookie.indexOf("=") + 1));
    const created = await newOperation("session.created", sessionsBefore, (operation) => operation.initiatingActor.id === world.teammateUserId);
    expect(created.event.actor).toMatchObject({ type: "user", id: world.teammateUserId });
    expect(created.event.changes?.after).toMatchObject({ method: "password" });

    // A wrong password for an existing member is a denied security event without the attempt.
    const wrongPassword = "audit-fixture-wrong-guess-not-a-password";
    credentials.push(wrongPassword);
    const failedBefore = await idsWith("session.sign_in_failed");
    const refused = await attemptPasswordSignIn(world.den.ref, { email: world.teammate.email, password: wrongPassword });
    expect(refused).toMatchObject({ status: 401, token: "" });
    const failed = await newOperation("session.sign_in_failed", failedBefore, () => true);
    expect(failed.event).toMatchObject({ category: "security", outcome: "denied", reasonCode: "invalid_credentials", actor: { type: "unknown", id: null } });
    expect(failed.event.resources).toEqual(expect.arrayContaining([expect.objectContaining({ type: "user", id: world.teammateUserId, relationship: "target" })]));

    const revokedBefore = await idsWith("session.revoked");
    expect(await signOutBrowserSession(world.den.ref, signedIn.cookie)).toBe(200);
    const revoked = await newOperation("session.revoked", revokedBefore, (operation) => operation.initiatingActor.id === world.teammateUserId);
    expect(revoked.event.reasonCode).toBe("sign_out");

    // An API-key script names the key, never its value.
    const apiKey = await createOrganizationApiKey(world.den.admin, "Audit proof script key");
    credentials.push(apiKey.key);
    const teamsBefore = await idsWith("team.create.succeeded");
    expect((await createTeamWithApiKey(world.den.ref, apiKey.key, "Audit proof scripted team")).response.status).toBe(201);
    const byKey = await newOperation("team.create.succeeded", teamsBefore, (operation) => operation.initiatingActor.credentialId === apiKey.id);
    expect(byKey.event.actor).toMatchObject({ type: "user", credentialId: apiKey.id });
    expect(byKey.event.http).toMatchObject({ method: "POST", route: "/v1/teams", status: 201 });

    // An MCP client's tool call is attributed to its person with origin MCP.
    const mcpToken = await mintMcpToken(world.den.admin);
    credentials.push(mcpToken);
    const skillsBefore = await idsWith("plugin.bundle.create.succeeded");
    const tool = await callMcpTool(world.den.ref, mcpToken, "create_skill", {
      pluginName: "Audit proof weekly report",
      skillMarkdown: "---\nname: audit-proof-weekly-report\ndescription: Summarize the week's work for the team.\n---\n\n# Weekly report\n\nSummarize this week's work in five bullet points.\n",
    });
    expect(tool).toMatchObject({ isError: false, rpcError: null });
    const viaMcp = await newOperation("plugin.bundle.create.succeeded", skillsBefore, (operation) => operation.origin === "mcp");
    expect(viaMcp.operation.initiatingActor.type).toBe("user");
    expect(viaMcp.operation.initiatingActor.memberId).toEqual(expect.any(String));

    // No credential used above appears anywhere the owner can read.
    const readable = [created.text, failed.text, revoked.text, byKey.text, viaMcp.text];
    for (const action of ["session.created", "session.sign_in_failed", "session.revoked", "team.create.succeeded", "plugin.bundle.create.succeeded"]) readable.push((await auditOperations(world.den.admin, `&action=${action}`)).text);
    expect(credentials.filter((secret) => secret.length >= 8 && readable.some((text) => text.includes(secret)))).toEqual([]);

    // The owner reads the denied sign-in and the MCP change in the audit page.
    await ui.filter("Session sign in failed", "sign in failed");
    expect(await ui.summary(failed.operation.id)).not.toBe("");
    await owner.notSee({ text: wrongPassword });
    await owner.screenshot();
    await ui.filter("Plugin bundle create succeeded", "plugin bundle create");
    expect((await ui.summary(viaMcp.operation.id)).startsWith("Audit Owner ")).toBe(true);
    await owner.screenshot();
  });
});
