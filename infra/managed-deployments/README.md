# Managed deployments: customer-cloud installers

OpenWork installed in a customer's own cloud account, launched and monitored
from hosted OpenWork. AWS uses CloudFormation/CodeBuild; GCP adds a
customer-approved Cloud Shell installer and Cloud Run platform behind the
default-off `managedDeploymentsGcp` rollout. Azure remains unsupported.
GCP offline validation is not a live-install or publication receipt; do not
roll it out before those gates pass.

```
contract/            Provider-neutral Terraform contract (inputs, naming, outputs)
aws/
  bootstrap/         CloudFormation the customer approves: runner + state only
  runner/            Installer run inside the customer's account (CodeBuild)
  health/            Read-only health agent (Lambda) reporting to OpenWork
  terraform/         AWS root: contract + network + platform + health agent
    modules/network/       AWS "network" building block
    modules/health-agent/  AWS "health agent" building block
    modules/openwork-aws-ecs/  Frozen pre-contract AWS platform
gcp/
  bootstrap/         Customer approval tutorial (immutable GCS artifact)
  runner/            Cloud Shell bootstrap and impersonated Terraform runner
  health/            Read-only Cloud Run health job
  terraform/         Cloud Run, Cloud SQL, HTTPS load balancer, DNS and secrets
  README.md          GCP permission, identity, state and rollout gates
tools/               Release build and publication (provider argument)
tests/               Installer, runner and health agent tests
```

The managed AWS platform is a frozen pre-contract copy at
`aws/terraform/modules/openwork-aws-ecs`. It is intentionally independent of
`infra/terraform/modules/openwork-aws-ecs`, which evolves for direct Terraform
users. Managed installs retain the current dev implementation, including the
runner behavior updates, without adopting the direct module's contract lifecycle.

## Frozen AWS platform boundary

The complete snapshot is byte-identical to the shared module at source commit
`8b586b13ab89b78379fbecd8ddb9c7c7caba31f8`, Git tree
`561d5b63514a13df471ad7458eae2b620cfc5803`. This refresh includes the current
runner behavior rather than reverting to an older installer snapshot. The
release builder packages its ten operational Terraform files under the managed
root, excludes examples/tests and the evolving direct-user module, and suppresses
macOS metadata sidecars. Regression tests pin the whole snapshot and compare
actual archive members and file bytes. Existing GCP image resolution and
mandatory registry verification are retained independently.

This is a compatibility boundary, not adoption of the newer module's security
or migration lifecycle. Do not refresh the snapshot as part of unrelated module
work. A separate owner-reviewed installer migration must handle supporting-file
packaging, deployment-scoped Lambda/IAM/log permissions and customer re-approval,
legacy maintenance/drain fencing, and update/version semantics. Current dev's
bootstrap, runner, health-agent and provider-pin behavior is retained.

## The contract every cloud implements

1. **Bootstrap** the customer approves in their own console. It creates only an
   installer identity, a runner and encrypted, retained Terraform state. AWS:
   CloudFormation quick-create. Azure: a "Deploy to Azure" ARM/Bicep template.
   GCP: Infrastructure Manager or a Cloud Shell tutorial.
2. **Runner** that enrolls with a cloud identity proof, verifies the release
   checksum, runs `terraform plan` + `apply` against the cloud root, refuses to
   delete data-bearing resources, verifies services and HTTPS health, and reports
   the six milestones (`runner_connected` … `health_verified`).
3. **Terraform root** that calls `contract/` with the neutral inputs
   (`deployment_id`, `domain_name`, `owner_email`, `openwork_version`,
   `control_plane_origin`, `size`), adds its own cloud inputs, and returns the
   neutral outputs (`web_url`, `api_url`, `setup_url`, `health_agent`). It
   composes the same building blocks: network, platform (containers, database,
   load balancer, certificate, DNS, secrets) and health agent.
4. **Health agent** that runs every 5 minutes with read-only permissions and
   posts the same allowlisted report (`packages/managed-deployments/src/schema.ts`,
   `healthReportSchema`) to `/v1/managed-deployments/:id/heartbeat`.
5. **Identity proof** the control plane can verify without stored secrets:
   AWS replays a signed STS `GetCallerIdentity`; Azure would verify a managed
   identity token and GCP a service-account ID token against their issuers.

Cloud-specific values (AWS account and Route 53 zone; later Azure subscription
or GCP project ID/number, region and DNS zone) live in the deployment's `target`,
never in the contract. API deployment views are discriminated by provider, so an
AWS target cannot be read as a GCP project. Both use the same ordered milestones,
allowlisted reports and customer-approved updates. GCP ID tokens are verified
against fixed Google JWKS, the exact service-account email, fresh issue time,
and an audience binding the enrollment challenge or exact heartbeat body hash.
Reports keep working when a feature is killed; launches fail closed.

## Security model

- A dedicated cloud account per deployment (default), or the customer's
  existing network: the AWS target's `network` is `dedicated` (own VPC and ECS
  cluster) or `existing` (customer VPC, subnets and optional ECS cluster). In
  an existing network the runner's permissions are limited to resources named
  with, or tagged at creation for, its deployment, and it checks the network
  (subnets, routes, DNS, cluster) before changing anything. No customer cloud
  keys are stored by OpenWork and no inbound access is needed: the runner and
  the agent call out.
- Release bundles and the Terraform binary are verified by SHA-256 before
  execution; published files are referenced by immutable S3 object versions.
  Terraform and provider versions are pinned with a committed lock file.
- State is customer-owned: versioned, encrypted S3 with S3-native locking,
  retained if the bootstrap stack is deleted.
- Only this stack's CodeBuild project can assume the runner role, the launcher
  cannot override the buildspec, image or privileged mode, and the runner cannot
  start or edit builds. In the dedicated account, grant `codebuild:StartBuild`
  on the installer project only to administrators.
- The runner role has no delete permissions except Terraform's own lock file, a
  certificate that failed validation (so a retry can request a new one), and
  superseded ECS task definitions. Plans that delete or replace databases,
  secrets, storage or the VPC are refused.
- Health reports contain only check ids, states, numbers and codes. No logs,
  hostnames, secrets or customer data leave the account.

## Run the checks

```bash
(cd contract && terraform init -backend=false && terraform test)
(cd aws/terraform && terraform init -backend=false -lockfile=readonly && terraform validate && terraform test)
(cd gcp/terraform && terraform init -backend=false -lockfile=readonly && terraform validate && terraform test)
node aws/bootstrap/template.mjs            # regenerates aws/bootstrap/cloudformation.json
python3 -m unittest discover -s tests       # needs boto3
```

Release and operator steps: `docs/managed-deployments.md`.
