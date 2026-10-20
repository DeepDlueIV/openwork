# Deployment service readiness

Self-hosted Den's **Settings › Services** is the installation operator's normal
service diagnostic surface. Internal platform operators can also use
**Admin › Services**. Neither surface is a requirement to run optional services. A core self-hosted installation still works without an AI
Gateway, headless runner, Workbot, Slack assistant, or outbound email service.
This change does not deploy any of them, require new credentials, or block
startup, upgrades, ordinary requests, or existing conversations.

## Rollout

`serviceReadiness` is available on cloud and self-hosted installations and starts
off. Enable it deployment-wide from **Admin › Feature rollouts**, or use the
self-hosted operator lock `config.features.serviceReadiness: "true"` in Helm
(`DEN_FEATURE_SERVICE_READINESS=true`). Organization overrides alone do not
authorize platform diagnostics or deployment probes.

The kill switch returns to the existing UI behavior. It does not delete
configuration, change model selections, stop running work, or modify the public
`/health` and `/ready` checks.

## Installation authority

Settings › Services is shipped in normal Den, not dependent on the platform
console. It is visible only when the API confirms that the current genuine user
session belongs to an active member of the selected organization, the deployment
is `self_hosted`, the user is in this installation database's administrator
allowlist, and `serviceReadiness` is enabled for both the organization and the
deployment. The deployment discriminator is server configuration, never an
organization mode, hostname, request header, or browser assertion.

Successful signed `/setup` bootstrap enrolls the first installation administrator
in that local allowlist, including when eligibility comes only from
`DEN_SINGLE_ORG_OWNER_EMAILS`. No separate `DEN_BOOTSTRAP_ADMIN_EMAILS` entry is
required for that administrator. Existing installations may seed their local
allowlist with `DEN_BOOTSTRAP_ADMIN_EMAILS`. Human-readable allowlist notes are
not authorization. Organization creation, singleton ownership, organization admin
roles and ownership transfers never grant installation authority.

An allowlisted operator can use Services with ordinary organization membership
without gaining access to unrelated organization settings. Removed members,
foreign organization selections and API keys cannot use the Settings API. Cloud
users, including allowlisted cloud platform operators, cannot use it. Existing
cloud provider and connector configuration remains independent; this does not
introduce another connector-health system.

`GET /v1/org` returns only the caller-specific `canManageDeploymentServices`
boolean, not a full diagnostic snapshot. Missing or malformed client capability
values mean false. Both direct page access and
`GET /v1/org/deployment-services` / `POST /v1/org/deployment-services/check`
independently enforce access; changing or retaining a stale client capability
cannot authorize a check. The minimal read-only `/v1/org/service-readiness`
projection has no probe control or setup field names.

## Reading the result

- **Ready:** the particular health check succeeded. It is not proof a model can
  answer, an email can be delivered, or an entire workflow can finish.
- **Not set up:** an optional service has not been configured. This is normal.
- **Misconfigured:** a required setting is missing or the service is wired
  incorrectly. Technical details name settings, never their values.
- **Unreachable:** a configured service did not answer or rejected the check.
- **Couldn't verify:** no supported, non-destructive check establishes the fact.
  Configuration presence alone must not turn this green.

A stale result is labeled as such. A successful check's timestamp is retained
when a later check fails; it is history, not evidence the service is healthy now.
The organization view receives only minimal status, not operator setting names,
origins, credentials, provider errors, or another member's grants.

## What is checked

| Service | Evidence and limits |
| --- | --- |
| Database | A real database query, not the fact that the API process is running. |
| AI Gateway | Fixed health/readiness endpoints identify the service and its database check. This does not contact upstream model providers or verify member inference access. |
| Headless runner | A versioned, service-authenticated health response identifies the runner and reports validated model/resume configuration presence. It neither runs a model nor creates a conversation. |
| Workbot | A service-authenticated response identifies the app, reports runner configuration presence, and compares its Den origin with the expected deployment origin. This does not test OAuth sign-in or a conversation. |
| Slack assistant | Deployment dependency status is separate from each organization's Slack installation, credentials, scopes and member identity. No events or messages are sent, and no recent event is required to call an installation healthy. |
| Resumable answers | Den and runner configuration facts do not establish a successful member-bound resume exchange. Unverified callbacks stay unverified; the check never calls the token/grant issuer. |
| Email | Recognizes the configured transport without sending a message. Configuration is not delivery verification; unsupported verification remains unknown. |

Older runners or Workbot versions without the internal health protocol remain
unverified rather than being mistaken for a working service. Their existing
liveness endpoints and running work are unchanged.

## Operation and safety

**Check now** requires installation-operator authority in self-hosted Settings,
or platform-admin authority in the separate internal console. It is rate-limited,
bounded and deduplicated. Both full-diagnostic entrypoints share exactly one
controller, admission namespace, in-flight check and recent matching snapshot.
Snapshot reads do not wait for a remote probe. Full operator inventory reads may
queue stale-while-revalidate through that same admission; minimal organization
readiness requests never launch probes. Already-configured Redis shares sanitized snapshots; Redis is not
required. Without it, snapshots are process-local, so a load-balanced request may
show unknown or stale status until that replica can perform an admitted check.
This is not a fleet-wide monitoring guarantee. Checks use only
operator-configured origins and fixed paths;
callers cannot supply a destination or credentials. Redirects and unsupported
responses fail closed. No request sends paid inference, email or Slack messages,
mints member model credentials, provisions a model provider, or repairs data.

Service health is never an authorization grant. Model assignments, connector
consent, organization permissions and run/resume authorization remain
independently enforced. Missing optional infrastructure can produce a useful
setup notice; a transient health failure must not remove history or disable
unrelated settings.

This page shares Den's authentication and database dependencies. If Den itself
cannot serve authenticated requests, use the existing liveness/readiness probes
and deployment logs; this is not an out-of-band monitoring service.

The headless runner's `GET /v1/health` uses its existing service bearer token.
Workbot's `GET /internal/readiness` uses the existing runner service token.
Neither endpoint returns setting values, tenant identities or credentials.
Adding a headless runner deployment to the Helm chart is a separate packaging
change, not part of service readiness.
