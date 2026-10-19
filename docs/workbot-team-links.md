# Team settings from Workbot

`workbotTeamLinks` is off by default on cloud and self-hosted deployments.
Turning it off locks the entry for members who could use it; it does not change
connections, model settings, conversations or drafts.

Den resolves the member's current permissions from the Workbot token's
organization, not from browser-supplied organization headers:

- **Workbot settings** needs `inference.view` or `inference.manage`.
- **Manage apps for your team** needs `connections.manage` and
  `connections.view`, matching Den's organization connection list.
- Members without those permissions see no admin entry. Older Den/Workbot
  hosts that omit the optional response field show no entry either.

Links open a new tab at `/dashboard/workbot-settings` or
`/dashboard/mcp-connections`, carrying `workbotOrganizationId`. Den verifies
that this exact organization is in the signed-in account's directory and
loads it before rendering the destination. It never falls back to a remembered
or active organization when the linked organization is unavailable. The hint
is consumed after a successful load so later explicit organization switches
remain authoritative. Destination APIs still enforce their own permissions;
links are not authorization grants. Writes retain the existing recent-sign-in
checks.

The feature is proved by `workbot-team-links.proof.test.ts`,
`workbot-team-destination.proof.test.ts`, the colocated organization-link unit
tests and `workbot-team-links.api.test.ts`.
