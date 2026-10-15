import { expect } from "vitest";
import {
  advertisedAcsLocation,
  assignMemberRole,
  deliverSamlResponse,
  googleShapedSamlResponse,
  inviteSignUpAndAccept,
  issueScimToken,
  membershipState,
  oktaUser,
  organizationIdNamed,
  organizationMembershipId,
  passwordSignInSucceeds,
  readSamlServiceProviderMetadata,
  readSsoConnection,
  registerSamlConnection,
  removeScimProvisioning,
  SCIM_BASE_PATH,
  scimClient,
  scimFormattedName,
  scimTotal,
  signedInEmail,
  signIn,
  signInForSessionCookie,
} from "@openwork/behaviors";
import type { OrgCaller } from "@openwork/behaviors";
import { eventually, inviteMember, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import { enableScimFixtureSso } from "../helpers/scim-fixture.ts";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
  // enableScimFixtureSso writes to the isolated testkit database that only a local Den exposes.
  placement: "local",
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Okta-shaped SCIM lifecycle skipped — needs: ${missingRequirements.join(", ")}`
  : "an Okta-shaped SCIM client provisions, renames, deprovisions, and reactivates a member without ever granting password access";

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry: unknown = Reflect.get(value, key);
  return typeof entry === "string" ? entry : null;
}

test(title, { timeout: 1_800_000 }, async ({ evidence, place }) => {
  needs(requirements);

  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const orgName = `Okta SCIM Lifecycle ${runId}`;
  const managedDomain = "okta-scim.test";
  const managedEmail = `avery.${runId}@${managedDomain}`;
  const memberPassword = "OpenWorkEval123!";

  await using den = await server({ place, org: { name: orgName, admin: { name: "SCIM Admin" } } });
  const control = await inviteMember(den, "control", { email: `control.${runId}@openwork.test`, name: "Control Member", password: memberPassword });
  const controlSession = await signIn(den.ref, { email: control.email, password: memberPassword });
  const organizationId = await organizationIdNamed(den.ref, den.admin, orgName);
  const owner: OrgCaller = { session: den.admin, cookie: await signInForSessionCookie(den.ref, den.admin), orgId: organizationId };
  const joined = (email: string, expected: boolean, label: string) => eventually(() => membershipState(den.ref, owner, email), {
    // SCIM writes bypass the 60s organizationContext cache TTL.
    within: 90_000, label, until: (state) => state.joined === expected,
  });

  // ── SSO setup is owner-only: an organization admin is refused, naming sso.manage ──
  const ssoAdmin = await inviteMember(den, "ssoAdmin", { email: `sso-admin.${runId}@openwork.test`, name: "SSO Admin", password: memberPassword });
  const promotion = await assignMemberRole(den.admin, { "x-openwork-org-id": organizationId }, await organizationMembershipId(den.ref, owner, ssoAdmin.email), "admin");
  expect(promotion.status, JSON.stringify(promotion.body)).toBe(200);
  const ssoAdminCaller: OrgCaller = { session: ssoAdmin, cookie: await signInForSessionCookie(den.ref, { email: ssoAdmin.email, password: memberPassword }), orgId: organizationId };
  const adminSamlAttempt = await registerSamlConnection(den.ref, ssoAdminCaller, {
    issuer: `http://127.0.0.1/okta/admin-attempt-${runId}`, domain: `admin-attempt-${runId}.test`,
    entryPoint: `https://okta.example.test/app/openwork/admin-attempt-${runId}/sso/saml`, cert: "okta-test-signing-certificate", audience: den.ref.apiUrl,
  });
  expect(adminSamlAttempt.response.status, adminSamlAttempt.text).toBe(403);
  expect(adminSamlAttempt.body).toMatchObject({ error: "forbidden", requiredPermission: "sso.manage" });

  // The org-scoped token route requires a verified, enabled SSO connection. Den's
  // dev-loopback issuer path makes domain verification deterministic while the
  // Okta-shaped entry point, certificate, and ACS contract remain real.
  const sso = await registerSamlConnection(den.ref, owner, {
    issuer: `http://127.0.0.1/okta/exk-${runId}`, domain: managedDomain,
    entryPoint: `https://okta.example.test/app/openwork/exk-${runId}/sso/saml`, cert: "okta-test-signing-certificate", audience: den.ref.apiUrl,
  });
  expect(sso.response.ok, sso.text.slice(0, 500)).toBe(true);
  await enableScimFixtureSso(den.database, organizationId);
  const connection = await readSsoConnection(den.ref, owner);
  expect(connection).toMatchObject({ status: "enabled", domainVerified: true });
  if (!connection.acsUrl) throw new Error(`SAML registration did not advertise an ACS URL: ${sso.text.slice(0, 500)}`);
  const malformed = await deliverSamlResponse(connection.acsUrl, "not-base64-xml");
  expect(malformed.status).toBe(400);
  expect(malformed.text).toContain("invalid_encoding");
  expect(malformed.text).not.toContain("invalid_saml_configuration");

  // ── The IdP's view: Settings' ACS matches the SP metadata, and only responses addressed there clear delivery ──
  const spMetadata = await readSamlServiceProviderMetadata(den.ref, owner);
  expect(spMetadata.response.status, spMetadata.text.slice(0, 500)).toBe(200);
  const advertisedAcsUrl = advertisedAcsLocation(spMetadata.text);
  expect(advertisedAcsUrl, `SP metadata did not advertise an ACS location: ${spMetadata.text.slice(0, 800)}`).toBeTruthy();
  expect(new URL(connection.acsUrl).href).toBe(new URL(advertisedAcsUrl).href);
  const addressedToUs = await deliverSamlResponse(advertisedAcsUrl, googleShapedSamlResponse({ destination: advertisedAcsUrl, recipient: advertisedAcsUrl, audience: den.ref.apiUrl }));
  // Unsigned, so the signature check still refuses it afterwards — but never as a delivery mismatch.
  expect(`${addressedToUs.finalUrl} ${addressedToUs.text}`).not.toMatch(/invalid_destination|invalid_recipient/);
  const addressedElsewhere = await deliverSamlResponse(advertisedAcsUrl, googleShapedSamlResponse({ destination: "https://attacker.example/acs", recipient: "https://attacker.example/acs", audience: den.ref.apiUrl }));
  expect(addressedElsewhere.status, addressedElsewhere.text.slice(0, 300)).toBe(400);
  expect(addressedElsewhere.text).toContain("invalid_destination");

  // ── Frame 1: Den issues the org's Okta bearer, never a raw BA token ──────
  expect((await scimClient(den.ref.apiUrl, "nonsense").list()).status).toBe(401);
  const token = await issueScimToken(den.ref, owner);
  if (token.status !== 201 || !token.scimToken || !token.baseUrl) throw new Error(`SCIM token creation failed: HTTP ${token.status}`);
  expect(new URL(token.baseUrl).pathname).toBe(SCIM_BASE_PATH);
  const okta = scimClient(den.ref.apiUrl, token.scimToken);
  const emptyAfterGarbage = await okta.list();
  expect(emptyAfterGarbage.status).toBe(200);
  expect(scimTotal(emptyAfterGarbage), `list after garbage bearer: ${emptyAfterGarbage.text.slice(0, 300)}`).toBe(0);

  // ── Frame 2: Okta checks for an existing assignment before creating it ───
  const lookup = await okta.findByUserName(managedEmail);
  expect(lookup.status).toBe(200);
  expect(scimTotal(lookup), `pre-create lookup: ${lookup.text.slice(0, 300)}`).toBe(0);

  // ── Frame 3: Okta provisions membership, not a password credential ───────
  const avery = oktaUser(managedEmail, `00u-${runId}`, "Avery", "Morgan");
  const created = await okta.create(avery);
  const scimUserId = stringField(created.body, "id");
  if (created.status !== 201 || !scimUserId) throw new Error(`SCIM user creation failed: HTTP ${created.status} ${created.text.slice(0, 500)}`);
  await joined(managedEmail, true, "SCIM-created member to appear in organization context");
  const passwordAfterCreate = await passwordSignInSucceeds(den.ref, managedEmail, "not-a-scim-password");
  const allAfterCreate = await okta.list();
  expect(passwordAfterCreate).toBe(false);
  expect(scimTotal(allAfterCreate), `list after create: ${allAfterCreate.text.slice(0, 300)}`).toBe(1);

  // ── Frame 4: Okta's full profile replacement changes only that profile ───
  const renamed = await okta.replace(scimUserId, oktaUser(managedEmail, `00u-${runId}`, "Avery", "Nguyen"));
  const renamedGet = await okta.get(scimUserId);
  expect([renamed.status, renamedGet.status]).toEqual([200, 200]);
  expect(scimFormattedName(renamedGet), `renamed user: ${renamedGet.text.slice(0, 300)}`).toBe("Avery Nguyen");

  // ── Frame 5: deprovisioning blocks resurrection and leaves others alone ──
  const deactivated = await okta.deactivate(scimUserId);
  expect(deactivated.status, `deactivate user: ${deactivated.text.slice(0, 300)}`).toBe(204);
  await joined(managedEmail, false, "SCIM-deprovisioned member to leave organization context");
  const passwordAfterDeprovision = await passwordSignInSucceeds(den.ref, managedEmail, "still-not-a-scim-password");
  const resurrection = await inviteSignUpAndAccept(den.ref, owner, { email: managedEmail, name: "Avery Nguyen", password: "PasswordMustNotWork123!" });
  const afterInvite = await membershipState(den.ref, owner, managedEmail);
  const controlAfter = await membershipState(den.ref, owner, control.email);
  const controlMe = await signedInEmail(den.ref, controlSession);
  expect(passwordAfterDeprovision).toBe(false);
  if (resurrection.accept) {
    expect(resurrection.accept.status, `explicit resurrection refusal: ${JSON.stringify(resurrection.accept.body).slice(0, 300)}`).toBe(409);
    expect(stringField(resurrection.accept.body, "error")).toBe("scim_deprovisioned");
  }
  expect(afterInvite.joined).toBe(false);
  expect(afterInvite.invitationStatus).not.toBe("accepted");
  expect(afterInvite.pendingUserId).toBe(null);
  expect(controlAfter.joined).toBe(true);
  expect(controlMe).toEqual({ status: 200, email: control.email });
  evidence.recordAssertionEvidence(
    "Okta deprovisioning cannot be bypassed and does not touch the control member",
    `PATCH active=false returned 204; invite-backed sign-up returned ${resurrection.signUpStatus}${resurrection.accept ? `, explicit acceptance → ${resurrection.accept.status} ${stringField(resurrection.accept.body, "error")}` : ""}; ${managedEmail} joined=${afterInvite.joined}, invitation ${afterInvite.invitationStatus}; ${control.email} joined=${controlAfter.joined}, /v1/me ${controlMe.status}.`,
    !afterInvite.joined && afterInvite.invitationStatus !== "accepted" && controlAfter.joined && controlMe.email === control.email,
  );

  // ── Frame 6A: Okta cannot absorb an existing personal account ────────────
  const averyReprovision = await okta.create(avery);
  expect(averyReprovision.status, `re-provision existing personal account: ${averyReprovision.text.slice(0, 300)}`).toBe(409);
  expect(stringField(averyReprovision.body, "scimType")).toBe("uniqueness");

  // ── Frame 6B: Okta re-provisioning is the only way back in ───────────────
  const blakeEmail = `blake.${runId}@${managedDomain}`;
  const blake = oktaUser(blakeEmail, `00u-blake-${runId}`, "Blake", "Morgan");
  const blakeCreated = await okta.create(blake);
  const blakeUserId = stringField(blakeCreated.body, "id");
  expect(blakeCreated.status, `create fresh SCIM user: ${blakeCreated.text.slice(0, 300)}`).toBe(201);
  if (!blakeUserId) throw new Error(`Fresh SCIM user creation omitted id: ${blakeCreated.text.slice(0, 500)}`);
  await joined(blakeEmail, true, "fresh SCIM member to join organization context");
  expect((await okta.deactivate(blakeUserId)).status).toBe(204);
  await joined(blakeEmail, false, "deactivated fresh SCIM member to leave organization context");
  expect((await okta.get(blakeUserId)).status, "old fresh-user id after deprovision").toBe(404);
  const blakeReprovisioned = await okta.create(blake);
  const blakeReprovisionedId = stringField(blakeReprovisioned.body, "id");
  expect(blakeReprovisioned.status, `re-provision fresh SCIM user: ${blakeReprovisioned.text.slice(0, 300)}`).toBe(201);
  expect(blakeReprovisionedId).not.toBe(blakeUserId);
  if (!blakeReprovisionedId) throw new Error(`SCIM re-provisioning omitted id: ${blakeReprovisioned.text.slice(0, 500)}`);
  // Re-provisioning clears removal memory; the 60s organizationContext cache still applies.
  await joined(blakeEmail, true, "re-provisioned fresh SCIM member to join organization context");
  const blakeGet = await okta.get(blakeReprovisionedId);
  expect(blakeGet.status).toBe(200);
  expect(blakeGet.body).toMatchObject({ active: true });
  expect(scimTotal(await okta.list()), "list after fresh-user re-provisioning").toBe(1);
  expect(await passwordSignInSucceeds(den.ref, blakeEmail, "PasswordMustStillNotWork123!")).toBe(false);

  // ── Removing SCIM provisioning revokes the IdP's bearer: it can neither read nor recreate users ──
  const removedProvisioning = await removeScimProvisioning(den.ref, owner);
  expect(removedProvisioning.response.status, removedProvisioning.text.slice(0, 300)).toBe(204);
  expect((await okta.list()).status).toBe(401);
  expect((await okta.create(oktaUser(`stale.${runId}@${managedDomain}`, `00u-stale-${runId}`, "Stale", "Provider"))).status).toBe(401);
});
