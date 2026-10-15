import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { emailLinks, invitationsFor, invitationWitnesses, membersFor, orgInvite, privateSelfHostInvite, rows, signUpAttempt, text } from "../worlds/org-invite.ts";

const test = spec.world(orgInvite, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

test("cold cloud signup recovers from the verification email without an invitation", async ({ world, user, probe, step }) => {
  const person = world.identity("cold-signup");
  let currentCode = "";
  let recoveryLink = "";
  let actor = user;
  let session = world.owner;
  const noAuthentication = async () => {
    expect(await world.sessionsFor(person.email)).toEqual([]);
    expect(membersFor(await world.witnesses.org(text(world.organization.id)), person.email)).toEqual([]);
    expect(membersFor(await invitationWitnesses(world.other).org(text(world.otherOrg.id)), person.email)).toEqual([]);
    expect(await world.witnesses.emails("organizationInvite", person.email)).toEqual([]);
  };

  await step("signup sends an OTP but neither creates membership nor authenticates a wrong code", async () => {
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: "Email" }, person.email);
    await user.click({ role: "button", label: "Next" });
    await user.type({ role: "textbox", label: "Name" }, person.name);
    await user.type({ role: "textbox", label: "Password" }, person.password);
    await user.click({ role: "button", label: "Sign up" });
    await user.see({ role: "textbox", label: "Verification code" });
    await probe.eventually(() => world.witnesses.emails("verification", person.email), { within: 15_000, label: "cold signup verification email", until: (emails) => emails.length > 0 });
    currentCode = await world.witnesses.otp(person.email);
    const wrongCode = currentCode === "000000" ? "000001" : "000000";
    await user.type({ role: "textbox", label: "Verification code" }, wrongCode);
    await user.click({ role: "button", label: "Verify email" });
    await user.see({ text: /invalid.*(code|otp)|(code|otp).*invalid/i });
    await user.notSee({ role: "textbox", label: "Workspace name" });
    await user.notSee({ testId: "den-org-sidebar" });
    await noAuthentication();
  });

  await step("resend replaces the old OTP without allowing it to authenticate", async () => {
    const oldCode = currentCode;
    const before = await world.witnesses.emails("verification", person.email);
    await user.click({ role: "button", label: "Resend code" });
    await probe.eventually(() => world.witnesses.emails("verification", person.email), { within: 15_000, label: "resent verification email", until: (emails) => emails.length > before.length });
    currentCode = await world.witnesses.otp(person.email);
    expect(currentCode).not.toBe(oldCode);
    await user.type({ role: "textbox", label: "Verification code" }, oldCode, { replace: true });
    await user.click({ role: "button", label: "Verify email" });
    await user.see({ text: /invalid.*(code|otp)|(code|otp).*invalid/i });
    await user.notSee({ role: "textbox", label: "Workspace name" });
    await noAuthentication();
  });

  await step("the actual verification email contains a usable recovery link", async () => {
    const html = await world.witnesses.lastEmail("verification", person.email);
    const links = emailLinks(html).filter((link) => new URL(link).origin === new URL(world.den.ref.webUrl).origin);
    expect(links, "Signup verification email must link back to code entry/recovery, not strand the person with only an OTP").not.toEqual([]);
    recoveryLink = links[0];
    expect(new URL(recoveryLink).searchParams.has("invite")).toBe(false);
    expect(await world.witnesses.emails("organizationInvite", person.email)).toEqual([]);
  });

  await step("opening the email in a fresh browser resumes code entry without silently authenticating", async () => {
    const surface = await world.fresh(recoveryLink);
    actor = user.on(surface);
    await actor.see({ role: "textbox", label: "Verification code" }, { timeoutMs: 90_000 });
    await actor.see({ text: person.email });
    await actor.notSee({ testId: "den-org-sidebar" });
    await actor.notSee({ role: "textbox", label: "Workspace name" });
    await noAuthentication();
    await actor.type({ role: "textbox", label: "Verification code" }, currentCode);
    await actor.click({ role: "button", label: "Verify email" });
    await actor.see({ role: "textbox", label: "Workspace name" }, { timeoutMs: 30_000 });
    await actor.notSee({ role: "textbox", label: "Verification code" });
    session = await world.witnesses.sessionFor(person);
    expect(await invitationWitnesses(session).orgs()).toEqual([]);
  });

  await step("naming a workspace lands the person in their own organization, and a typed but unsent invite sends nothing", async () => {
    await actor.type({ role: "textbox", label: "Workspace name" }, "Simple workspace");
    await actor.click({ role: "button", label: "Create workspace" });
    await actor.see({ testId: "onboarding-teammates" }, { timeoutMs: 90_000 });
    await actor.type({ role: "textbox", label: "Teammate email 1" }, world.identity("never-invited").email);
    await actor.click({ role: "button", label: "Skip and open workspace" });
    await actor.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
    const own = invitationWitnesses(session);
    const orgs = await own.orgs();
    expect(orgs).toHaveLength(1);
    const org = await own.org(text(orgs[0].id));
    expect(membersFor(org, person.email)).toEqual([expect.objectContaining({ role: "owner" })]);
    expect(rows(org.invitations)).toEqual([]);
  });
});

const privateTest = spec.world(privateSelfHostInvite, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

privateTest("private self-host signup admits the bootstrap owner and invited outsider, but not an uninvited outsider", async ({ world, user, probe, step }) => {
  let orgId = "";
  await step("the configured bootstrap administrator owns the workspace without an invitation, and the code cannot be reused", async () => {
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
    expect(replay.response.status).toBe(409);
    expect(replay.body).not.toHaveProperty("grant");
  });

  await step("an uninvited outsider is refused and leaves no member, invitation, session or email behind", async () => {
    const witness = invitationWitnesses(world.den.admin);
    const before = await witness.org(orgId);
    const denied = await signUpAttempt(world.anonymous, world.rejected);
    expect(denied.response.status, denied.text).toBe(403);
    expect(denied.body).not.toHaveProperty("token");
    expect(await witness.org(orgId)).toEqual(before);
    expect(membersFor(before, world.rejected.email)).toEqual([]);
    expect(invitationsFor(before, world.rejected.email)).toEqual([]);
    expect(await witness.emails("verification", world.rejected.email)).toEqual([]);
  });

  await step("an invited outsider creates an account from the invitation and joins exactly once", async () => {
    const witness = invitationWitnesses(world.den.admin);
    const invite = await witness.invite(world.outsider.email, orgId);
    const ownerBefore = membersFor(await witness.org(orgId), world.owner.email);
    await user.navigate(invite.link);
    await user.see({ text: world.outsider.email }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: /^name$/i }, world.outsider.name);
    await user.type({ role: "textbox", label: /^password$/i }, world.outsider.password);
    await user.click({ role: "button", label: "Create account" });
    await user.click({ role: "button", label: `Join ${world.workspaceName}` });
    const org = await probe.eventually(() => witness.org(orgId), { within: 30_000, label: "invited outsider joins the private workspace", until: (value) => membersFor(value, world.outsider.email).length === 1 });
    expect(membersFor(org, world.outsider.email)).toEqual([expect.objectContaining({ role: "member" })]);
    expect(invitationsFor(org, world.outsider.email).filter((entry) => entry.status === "pending")).toEqual([]);
    expect(membersFor(org, world.owner.email)).toEqual(ownerBefore);
    await user.notSee({ role: "textbox", label: "Verification code" });
    const member = invitationWitnesses(await witness.sessionFor(world.outsider));
    expect((await member.orgs()).map((entry) => entry.id)).toEqual([orgId]);
    const replay = await member.api("/v1/orgs/invitations/accept", { method: "POST", body: JSON.stringify({ id: invite.token }) });
    expect(replay.response.ok, replay.text).toBe(true);
    expect(membersFor(await witness.org(orgId), world.outsider.email)).toHaveLength(1);
  });
});
