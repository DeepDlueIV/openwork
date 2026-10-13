# GCP managed deployments (off by default)

This installer runs in the customer's Cloud Shell, not in OpenWork's cloud.
Use a **dedicated, billing-enabled project**: the runner's deployment roles are
project-wide and are not safe isolation from unrelated workloads. Only the
customer approves IAM, API enablement, and billable resources. No account keys
are created. OpenWork receives an audience-bound service-account ID token and
allowlisted progress/health reports, never credentials, Terraform state, logs,
secret values, or the administrator bootstrap code.

## Release and launch contract

Package `runner/install.py`, `runner/runner.py`, `health/health_agent.py`,
`terraform/**/*.tf`, `terraform/.terraform.lock.hcl`, and the existing
`../contract/*.tf` in the checksummed release bundle, preserving repository paths.
`release.json` must contain `provider: "gcp"`, `version`, `protocolVersion: 1`,
and a `files` map of path to SHA-256. Publish `tutorial.md`, the bundle and
manifest as immutable GCS object generations. The control plane supplies the
pinned bundle hash. The launch command verifies that hash before safely
extracting and executing `infra/managed-deployments/gcp/runner/install.py`;
it **must not** pipe an unverified download to a shell.

Installer input is `--config-base64 <base64 JSON>` using the `GcpLaunch` shape in
`packages/managed-deployments/src/gcp.ts`: `deploymentId`, `runId`, `challenge`,
`target: {projectId, projectNumber, region, dnsZoneName}`, `domainName`,
`ownerEmail`, `size: "small"`, and
`release: {templateUrl, bundleUrl, bundleSha256, version, apiOrigin}`.
All fields are public configuration, not credentials. The bundle URL must be
`https://storage.googleapis.com/BUCKET/OBJECT?generation=DIGITS`.

The customer reviews the project, resource scope and cost, then types the exact
project ID to approve. The script verifies the project number and public DNS
zone before changing anything, checks the bundle before executing anything,
enables the required APIs, creates deterministic identities, and creates a
versioned GCS state bucket with uniform access and public-access prevention.
Google encrypts objects at rest. State is outside Terraform and never removed
by the installer. Terraform's native GCS backend supplies generation-based
locking. Retrying uses the same bucket and identities; existing insecure state
buckets are rejected rather than silently adopted. A separate retained GCS
`deployments/DEPLOYMENT_ID/orchestration.lock` object serializes the entire
image-mirroring, migration, rollout and readiness sequence, not just individual
Terraform commands. Creation requires `ifGenerationMatch=0`; only the process
holding the returned generation releases the live lock with that exact
`ifGenerationMatch`. Terraform's native state lock remains enabled as well.
Concurrent shells must not share local directories; a contending run fails
closed rather than waiting, expiring the lock, or stealing it.

### Interrupted-run lock recovery (customer administrator only)

Normal success or caught failure releases the orchestration lock. A killed
process, lost acquisition receipt, or failed release leaves it retained. There
is deliberately **no automatic stale-lock recovery**: an old timestamp does not
prove that an installer or migration has stopped.

1. Confirm the owning Cloud Shell process has stopped and no migration execution
   or rollout from it is still running. Do not recover a lock while its owner can
   continue. Inspect the lock's JSON `runId` and object metadata in the customer's
   project; do not send state, tokens, or command logs to OpenWork.
2. Record the lock's exact live object `generation`:
   `gcloud storage objects describe gs://STATE_BUCKET/deployments/DEPLOYMENT_ID/orchestration.lock --raw`.
3. Only after reviewing the interrupted run, remove **that specific generation**:
   `gcloud storage rm 'gs://STATE_BUCKET/deployments/DEPLOYMENT_ID/orchestration.lock#GENERATION'`.
   The generation-qualified URL cannot remove a newer owner's lock. Never use
   an unqualified delete, recursive delete, wildcard, or bucket deletion.
4. Retry the installer. If a lock still exists, inspect it again rather than
   deleting a different generation blindly. Do not force-unlock Terraform state
   merely because the orchestration lock exists; its lock is independent.

ADC consent is an explicit `gcloud auth application-default login` step; the
Terraform provider and backend impersonate the runner. The approving principal
gets Token Creator **only on that runner**. Terraform never runs as the user.
Runner roles allow changes across the dedicated project (not owner/editor or
project IAM admin); runtime and health IAM are bootstrapped by the customer.
The API/migration runtime gets access only to this deployment's secrets and
Cloud SQL. Den Web uses a separate identity with no project roles, secret access,
or Cloud SQL mount; the installer can act as it only to deploy Web.
The health identity has read-only Cloud Run/SQL/certificate visibility and no
secret accessor, DNS write, IAM write, or Terraform state access. Cloud Scheduler
uses a separate identity scoped to invoke the health job.

## Runtime

Cloud SQL MySQL 8 with backups and deletion protection; Secret Manager;
Cloud Run API/Web services and an explicit migration job; a global HTTPS load
balancer with managed certificate and Cloud DNS records; a five-minute Cloud
Run health job authenticated with a Google metadata ID token. The health image
is copied by digest into the customer's Artifact Registry alongside the exact
versioned OpenWork images. The API migration job runs **before** new service
revisions are applied. Plans reject deletion/replacement of data-bearing
resources, and Terraform lifecycle guards protect the database and secrets.

The runner enrolls using `{"provider":"gcp","idToken":"..."}` with audience
`API_ORIGIN/v1/managed-deployments/DEPLOYMENT/runs/RUN/enroll#CHALLENGE`.
Health uses `Authorization: Bearer <Google ID token>` with audience
`API_ORIGIN/v1/managed-deployments/DEPLOYMENT/heartbeat#SHA256(EXACT_BODY)`.
Each GCP report includes a fresh 32-character hex `nonce`, so even identical
snapshots request a different metadata-token audience. The API requires this
nonce and still enforces strict token freshness and issued-at replay checks.
The installed version is reported only when both services have observed the
current generation, the expected image, matching latest-created/latest-ready
revisions, and 100% actual traffic to that revision. Desired template images
alone cannot prove the installed version; old/split/missing traffic status
reports `services_running` as failing and omits the version.
SA names are `ow-<first 12 UUID hex digits>-runner` and `...-health`.
The API validates issuer, signature, audience, fresh issued-at, exact email,
and `email_verified`; no opaque self-reported identity is trusted.

## Limits / operator checks

This is new infrastructure, not an existing GCP module (none exists in this
checkout). It follows `packaging/cloud-run` rather than inventing a parallel app
configuration. Gateway and automations are disabled in the initial profile.
A published release must include Cloud SQL Unix-socket support. Public Cloud Run
invocation is needed behind the external load balancer; ingress is restricted to
`INTERNAL_LOAD_BALANCER`. Org policies may forbid public invocation or APIs,
service-agent creation, IAM grants, or public IP Cloud SQL. Resolve those with
customer administrators, never weaken policy automatically. Cloud SQL uses the
authenticated connector and no authorized networks. DNS must already be
authoritative, and CAA must allow Google's certificates. Certificate issuance
can take 60 minutes; a failed run can be retried after correcting DNS/CAA.

No cloud resources have been provisioned or releases published as part of
implementation. Local mocked security/protocol tests and Terraform validation
do not prove a live Cloud Run deployment. Customer-project end-to-end validation
and a real immutable release are rollout gates. Serverless NEG target health
is inapplicable and omitted (the actual HTTPS routes are checked instead).
Disk metrics and backups report `unknown/unavailable` while Google has no
measurements or successful backup yet, not fabricated successful checks.
Installed image tags are resolved to
immutable customer-registry digests during each approved run, not verified
against release-signed image digests. Do not enable the feature until
those gates pass.

Run offline checks: `python3 -m unittest discover -s infra/managed-deployments/tests -p '*gcp*'`.
Terraform: `terraform init -backend=false -lockfile=readonly`, `terraform validate`.
