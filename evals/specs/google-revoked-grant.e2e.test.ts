import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";
import { googleRevokedGrant } from "../worlds/google-revoked-grant.ts";

// Google answers invalid_grant once a member removes the app's access. Den must
// ask that member to connect again instead of failing every Google request.
test("a revoked Google grant asks the member to connect again instead of failing", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun", "pnpm"], placement: "local" });
  await using world = await googleRevokedGrant(place);
  expect((await world.status()).body).toMatchObject({ connected: true, externalAccountId: world.email });

  const renewed = await world.gmailMessages();
  expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
  const renewalsBefore = await world.tokenRequests();

  await world.revoke();
  const revoked = await world.gmailMessages();
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(409);
  expect(revoked.body).toMatchObject({ error: "needs_connection" });
  expect((await world.status()).body).toMatchObject({ connected: false });

  const again = await world.gmailMessages();
  expect(again.status, JSON.stringify(again.body)).toBe(409);
  expect(await world.tokenRequests(), "Den must not retry the dead grant").toBe(renewalsBefore + 1);
  evidence.recordAssertionEvidence(
    "A revoked Google grant asks the member to connect again",
    "After Google answers invalid_grant on renewal, Gmail returns 409 needs_connection instead of 500, the connection shows as not connected, and the next request makes no further token request.",
    true,
  );
});
