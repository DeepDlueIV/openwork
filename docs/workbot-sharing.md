# Share Workbot with coworkers

`workbotInvites` is off by default on cloud and self-hosted deployments. This
initial slice is **copy-only sharing**, not email invitations. A member can
copy the current Workbot URL, with a visible reminder that the link grants no
access and a team admin must invite coworkers in Den. Copy success follows the
real clipboard result; browser denial leaves the URL available for manual
copy. Turning the feature off removes the copy action and shows a lock with
its owner. No conversation or draft is changed.

## Invitation security boundary

This slice deliberately introduces no Workbot invitation-write endpoint.
Workbot authenticates with an MCP grant. That grant does not carry a verified
recent-authentication claim. Den's internal MCP re-entry synthesizes a current
session timestamp, so routing an invitation through it would not preserve the
existing recent-sign-in requirement.

Email invitations stay on Den's session-authenticated `/v1/invitations`
route, with `invitations.manage`, recent sign-in, seat checks and email-error
handling unchanged. A future in-Workbot invitation flow needs a server-verified
fresh-authentication proof or a real Den session handoff, explicit organization
binding, a signed and allowlisted acceptance return to Workbot, and typed-email
preservation across seat/payment and email-delivery failures. It must never
infer freshness from token issuance, refresh time, or Workbot cookie age.

Proof: `workbot-sharing.proof.test.ts` exercises current-URL copy and actual
browser clipboard denial; `workbot-sharing.api.test.ts` proves that an MCP
token, a member without invitation permission and a stale Den session still
cannot create an invitation.
