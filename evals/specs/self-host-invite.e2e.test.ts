import { expect } from "vitest";
import { personDefaults, selfHostServer, spec } from "@openwork/testkit";
import { invitationWitnesses, invitationsFor, localInviteNeeds, membersFor, record, rows, signUpAttempt, text } from "../worlds/org-invite.ts";

const test = spec.world(async (seed, { place }) => {
  await localInviteNeeds();
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const owner = personDefaults("bootstrap-owner", undefined, runId);
  const outsider = personDefaults("invited-outsider", { email: `invited-${runId}@outside.test` }, runId);
  const rejected = personDefaults("uninvited-outsider", { email: `uninvited-${runId}@outside.test` }, runId);
  const bootstrapCode = `test-bootstrap-${runId}`;
  const workspaceName = `Private workspace ${runId}`;
  const server = await selfHostServer({ place, name: workspaceName, slug: `private-${runId}`, ownerEmails: [owner.email], allowPublicSignup: false, bootstrapCode });
  try {
    const den = await seed.den({ reuse: server.ref, provision: false });
    const anonymous = den.admin;
    // The configured administrator claims the server with the bootstrap code
    // and signs up; the first step checks what that sign-up produced.
    const verified = await seed.api(anonymous, "/v1/auth/bootstrap/verify", { method: "POST", body: JSON.stringify({ email: owner.email, code: bootstrapCode }), signal: AbortSignal.timeout(15_000) });
    const grant = verified.response.status === 200 ? record(verified.body).grant : undefined;
    const ownerSignUp = await seed.api(anonymous, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ ...owner, bootstrapGrant: grant }), signal: AbortSignal.timeout(15_000) });
    const bootstrap = { verifyStatus: verified.response.status, verifyText: verified.text, grant, signUpOk: ownerSignUp.response.ok, signUpText: ownerSignUp.text };
    const web = await seed.web({ den, headless: true });
    return { den, web, owner, outsider, rejected, bootstrapCode, bootstrap, workspaceName, anonymous, async [Symbol.asyncDispose]() { await server[Symbol.asyncDispose](); } };
  } catch (error) {
    await server[Symbol.asyncDispose]();
    throw error;
  }
}, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

test("private self-host signup admits the bootstrap owner and invited outsider, but not an uninvited outsider", async ({ world, user, probe, seed, step, evidence }) => {
  let orgId = "";
  await step("the configured bootstrap administrator auto-joins without an invitation", async () => {
    expect(world.bootstrap.verifyStatus, world.bootstrap.verifyText).toBe(200);
    expect(world.bootstrap.grant).toEqual(expect.any(String));
    expect(world.bootstrap.signUpOk, world.bootstrap.signUpText).toBe(true);
    world.den.admin = await invitationWitnesses(world.anonymous).sessionFor(world.owner);
    const witness = invitationWitnesses(world.den.admin);
    const organizations = await witness.orgs();
    expect(organizations).toHaveLength(1);
    orgId = text(organizations[0].id);
    const org = await witness.org(orgId);
    expect(membersFor(org, world.owner.email)).toEqual([expect.objectContaining({ role: "owner" })]);
    expect(invitationsFor(org, world.owner.email)).toEqual([]);
    const replay = await witness.api("/v1/auth/bootstrap/verify", { method: "POST", body: JSON.stringify({ email: world.owner.email, code: world.bootstrapCode }) });
    const ownerRoles = membersFor(org, world.owner.email).map((member) => String(member.role));
    evidence.recordAssertionEvidence("the bootstrap administrator owns the workspace without an invitation, and the code cannot be reused", `organizations=${organizations.length}; owner roles=[${ownerRoles.join(", ")}]; replayed code → HTTP ${replay.response.status}`, organizations.length === 1 && ownerRoles.join() === "owner" && replay.response.status === 409);
    expect(replay.response.status).toBe(409);
    expect(replay.body).not.toHaveProperty("grant");
  });

  const witness = invitationWitnesses(world.den.admin);
  await step("public signup disabled rejects an uninvited outsider without a session or placeholder", async () => {
    const before = await witness.org(orgId);
    const denied = await signUpAttempt(world.anonymous, world.rejected);
    const after = await witness.org(orgId);
    const traces = membersFor(after, world.rejected.email).length + invitationsFor(after, world.rejected.email).length;
    evidence.recordAssertionEvidence("an uninvited outsider is refused and leaves no member, invitation or session behind", `sign-up → HTTP ${denied.response.status}; token returned=${denied.body !== null && typeof denied.body === "object" && "token" in denied.body}; member or invitation rows=${traces}`, denied.response.status === 403 && traces === 0);
    expect(denied.response.status, denied.text).toBe(403);
    expect(denied.body).not.toHaveProperty("token");
    expect(after).toEqual(before);
    expect(membersFor(before, world.rejected.email)).toEqual([]);
    expect(invitationsFor(before, world.rejected.email)).toEqual([]);
    expect(await witness.emails("verification", world.rejected.email)).toEqual([]);
  });

  await step("an invited outsider can create their account despite disabled public signup", async () => {
    const invite = await witness.invite(world.outsider.email, orgId);
    const ownerBefore = membersFor(await witness.org(orgId), world.owner.email);
    await user.navigate(invite.link);
    await user.see({ text: world.outsider.email }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: /^name$/i }, world.outsider.name);
    await user.type({ role: "textbox", label: /^password$/i }, world.outsider.password);
    await user.click({ role: "button", label: "Create account" });
    await user.see({ role: "button", label: `Join ${world.workspaceName}` }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: `Join ${world.workspaceName}` });
    const org = await probe.eventually(() => witness.org(orgId), { within: 30_000, label: "invited outsider joins the private workspace", until: (value) => membersFor(value, world.outsider.email).length === 1 });
    expect(membersFor(org, world.outsider.email)).toEqual([expect.objectContaining({ role: "member" })]);
    expect(rows(org.members).filter((member) => member.inviteId === invite.id)).toHaveLength(1);
    expect(rows(org.members).filter((member) => member.inviteId === invite.id && (!member.userId || !member.joinedAt))).toEqual([]);
    expect(invitationsFor(org, world.outsider.email).filter((entry) => entry.status === "pending")).toEqual([]);
    expect(membersFor(org, world.owner.email)).toEqual(ownerBefore);
    expect(membersFor(org, world.rejected.email)).toEqual([]);
    await user.notSee({ role: "textbox", label: "Verification code" });
    await user.reload();
    expect(membersFor(await witness.org(orgId), world.outsider.email)).toHaveLength(1);
    const member = await witness.sessionFor(world.outsider);
    expect((await invitationWitnesses(member).orgs()).map((entry) => entry.id)).toEqual([orgId]);
    const replay = await seed.api(member, "/v1/orgs/invitations/accept", { method: "POST", body: JSON.stringify({ id: invite.token }) });
    expect(replay.response.ok, replay.text).toBe(true);
    const joined = membersFor(await witness.org(orgId), world.outsider.email);
    evidence.recordAssertionEvidence("the invited outsider creates an account from the invitation and joins exactly once", `member rows=${joined.length}; role=${String(joined[0]?.role)}; repeated accept → HTTP ${replay.response.status}`, joined.length === 1 && joined[0]?.role === "member");
    expect(joined).toHaveLength(1);
  });
});
