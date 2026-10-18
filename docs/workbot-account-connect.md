# Connecting accounts in Workbot

`workbotInlineConnect` is off by default on cloud and self-hosted deployments.
The existing `DEN_WORKBOT_URL` fixes the only allowed Workbot origin; no new
provider credentials or product environment switches are introduced.

Workbot posts a connection ID, a bounded path-only return, and a random attempt
ID to `/v1/workbot/connections/:connectionId/connect/start`. Den verifies the
OAuth grant, write scope, active membership, and both Workbot flags. It re-enters
the existing member connection start with an in-process signed principal. The
token's organization is authoritative: a browser header cannot select another
organization. Existing native-provider grants, external per-member grants, and
shared-credential management permissions remain in force.

The existing OAuth state signs the member, organization, connection binding,
expiry, attempt ID, Workbot origin, and return path. Existing provider callback,
PKCE, issuer, and credential-persistence validation remains in place. A callback
may finish after the flag is killed, but no new inline flow can start. Changing
the configured origin prevents a previously signed return from being used.

Completion sends only a finite outcome, attempt ID, and connection ID to the
exact Workbot origin. Workbot accepts it only from the window it opened, at the
expected callback origin, for its current attempt. A message never marks an
account connected: Den's fresh connection readiness and resource reads must
confirm access. Denial, expiry, missing scopes, and incomplete admin setup stay
recoverable without exposing provider errors or tokens to chat.

A blocked popup offers an explicit same-tab action. A callback without an opener
offers a return link to the signed Workbot path. When inline connect is off,
the existing specific-connection Den link remains available, honestly labelled
“Finish in the new tab”, with readiness auto-detection. No migration, rollout,
or provider setup is performed by this change.

Verification: `workbot-connect.api.test.ts` covers authorization and isolation;
`workbot-connect.proof.test.ts` drives the real UI and Den callbacks against a
localhost fake provider and a disposable MySQL database. It does not prove live
provider configuration or deployment readiness.
