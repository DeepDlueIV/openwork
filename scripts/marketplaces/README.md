# Gateway preflight tooling

Dependency-free maintainer checks for the hosted OpenWork MCP gateway. These
checks report technical observations, not client support certification,
marketplace eligibility, submission, approval or publication.

Requires Node 24+; the private-state guards use Unix owner-only permissions.

## Offline tests

```sh
node --test scripts/marketplaces/*.test.mjs
```

Tests mock network requests and do not provision live accounts or workspaces.
The path-filtered Marketplace artifact checks workflow runs them in CI without
credentials or live service calls.

## Public preflight

```sh
node scripts/marketplaces/gateway-preflight.mjs --public
```

This mode sends one unauthenticated MCP request and reads public OAuth metadata,
the official MCP Registry entry and public setup/privacy/terms pages. It creates
no workspace and uses no account credentials. A failed independent check makes
the command exit nonzero; it is not evidence of delisting or an OAuth outage
without identifying the failing request.

## Explicit synthetic QA

Only run live QA with authorization. Use a new owner-only directory outside the
checkout and do not place it in another repository.

```sh
node scripts/marketplaces/gateway-preflight.mjs --prepare-qa /absolute/private/new-directory
node scripts/marketplaces/gateway-preflight.mjs --check-qa /absolute/private/new-directory
```

`--prepare-qa` reserves the local state file before creating one isolated
provisional workspace. A blind rerun never overwrites existing state or creates
a second workspace. If provisioning fails, inspect the result and choose an
explicit recovery rather than deleting the reservation and retrying blindly.

`--check-qa` reuses that workspace and its synthetic fixture. It verifies token
exchange, MCP initialization, tool annotation presence, fixture list/read and
exact-capability retrieval. A missing fixture is seeded from
[`fixtures/reviewer-weekly-brief/SKILL.md`](fixtures/reviewer-weekly-brief/SKILL.md)
only in that isolated workspace. Skill names/frontmatter may be canonicalized;
the instruction body must match.

The workspace/assertion expires after 72 hours. State is stored as
`bootstrap.json` with mode `0600` in an owner-only directory. Known credentials
and untrusted error bodies are kept out of the printed report. Never commit,
attach or publish the state file, assertion, claim links, access token or raw
network captures. Claiming the workspace revokes its anonymous credentials.

This is not a durable reviewer login, browser authorization-code OAuth test,
refresh/revocation/isolation test, model-behavior test or native-client journey.
The tool does not invite members, enable billing, connect real providers, send
messages, submit applications or accept publisher terms. Keep operational
submission packets, account coordination, draft correspondence and run-specific
evidence outside the codebase.
