# openwork-gcp-cloud-run (Terraform, draft)

Runs a private, single-organization OpenWork control plane (Den) on Google
**Cloud Run**, without Kubernetes. It is the Terraform form of the manual
[Cloud Run guide](../../../../docs/gcp-cloud-run.md) and the Google Cloud
counterpart of [`openwork-aws-ecs`](../openwork-aws-ecs):

| Piece | Google Cloud resource |
| --- | --- |
| Den API (`ghcr.io/different-ai/openwork-den-api`, port 8788) | Cloud Run service `<name>-den-api` |
| Den web (`ghcr.io/different-ai/openwork-den-web`, port 3005) | Cloud Run service `<name>-den-web` |
| Database migrations | Cloud Run job `<name>-den-migrate`, executed by `terraform apply` before den-api is updated; a failed migration fails the apply |
| MySQL 8.4 | Cloud SQL, reached through Cloud Run's Cloud SQL connector (or a private IP, or bring your own `database_url`) |
| Images | Artifact Registry remote repository `<name>-ghcr` that proxies ghcr.io (Cloud Run cannot pull from ghcr.io), or your own image references |
| HTTPS | The services' default `https://<service>-<project number>.<region>.run.app` URLs, or a global external HTTPS load balancer for `domain_name` and `api.<domain_name>` with a Google-managed certificate |
| Secrets | One Secret Manager secret per value, read by a dedicated service account |
| Logs | Cloud Logging (`resource.type="cloud_run_revision"` / `cloud_run_job`) |
| Network (optional) | Direct VPC egress into your existing VPC (`network`, `subnetwork`) |

It sets the same environment as `packaging/cloud-run` and the
[`openwork-ee` Helm chart](../../../../packaging/helm/openwork-ee), so the
chart's README and `ee/apps/den-api/.env.example` document every setting you
can add through `extra_environment`.

> **Status: draft.** Applied in a Google Cloud test project with
> `examples/complete` (release 0.18.58, Direct VPC egress into a separately
> created VPC): the migration job during apply, HTTPS on both run.app URLs and
> on both load balancer hostnames (managed certificate), database readiness,
> the one-time `/setup` administrator and sign-in. The test account had only
> Project Editor, so it ran with `grant_iam_roles = false`,
> `secret_manager_enabled = false` and `public_access = false`, and called
> den-api with a Google identity token. Not yet exercised live: the IAM and
> Secret Manager bindings, sign-in through den-web in a browser, the desktop
> app, a private-IP or existing database, more than one den-api instance,
> SMTP/Resend delivery, upgrades across releases. OpenWork Web, Slack,
> headless Automations and Workbot are not part of this module yet.

## Before you start

- A Google Cloud project with billing, and these APIs enabled: `run`,
  `sqladmin`, `secretmanager`, `artifactregistry`, plus `compute` for
  `domain_name` or `network`.
- Permission to create Cloud Run services and jobs, Cloud SQL, secrets and a
  service account, **and to set IAM policies**: the module grants the service
  account `roles/cloudsql.client` on the project and
  `roles/secretmanager.secretAccessor` on each secret, and turns off Cloud
  Run's invoker check (`run.services.setIamPolicy`). Project Editor alone
  cannot do this; add Project IAM Admin, Secret Manager Admin and Cloud Run
  Admin. If your platform team owns IAM, have it grant those two roles to an
  existing service account, pass it as `service_account_email`, and set
  `grant_iam_roles = false`.
- OpenWork 0.18.57 or later (Cloud SQL socket support in `DATABASE_URL`).
- **HTTPS is required.** Den refuses to start with a plain-HTTP public URL
  outside dev mode. Without a domain, the run.app URLs give you HTTPS. With
  `domain_name`, both hostnames must resolve to the `load_balancer_ip` output
  before the managed certificate becomes active (usually 15-60 minutes).
- Credentials for the Google provider: application default credentials
  (`gcloud auth application-default login`), or a service account through
  `GOOGLE_APPLICATION_CREDENTIALS` or workload identity in CI. (For a quick
  test where application default credentials are blocked, the provider also
  accepts a short-lived token: `GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth
  print-access-token)" terraform apply`. It expires after about an hour.)

## Usage

```hcl
module "openwork" {
  source = "github.com/different-ai/openwork//infra/terraform/modules/openwork-gcp-cloud-run?ref=<commit>"

  project_id       = "my-project"
  region           = "us-central1"
  openwork_version = "0.18.58"
  owner_emails     = ["admin@example.com"]
  org_name         = "Example Co"

  # Optional: custom hostnames behind an HTTPS load balancer.
  # Empty uses the run.app URLs.
  domain_name = "openwork.example.com" # API: api.openwork.example.com

  # Optional: existing VPC for Direct VPC egress.
  network    = "projects/my-project/global/networks/shared"
  subnetwork = "projects/my-project/regions/us-central1/subnetworks/cloud-run"

  # Optional: email.
  email_from = "OpenWork <no-reply@example.com>"
  smtp = {
    host     = "smtp.example.com"
    username = var.smtp_user
    password = var.smtp_password
  }
}
```

After `terraform apply`:

1. With `domain_name`, create A records for both names in the `dns_records`
   output and wait for the certificate to become active.
2. `terraform output -raw bootstrap_code` (generated unless you set
   `initial_admin_bootstrap_code`).
3. Open the `setup_url` output, enter an owner email and that code, and
   create the first administrator. `/setup` works once, while the database
   has no users.
4. In OpenWork Desktop, set **Cloud control plane URL** (on the sign-in
   screen) to `web_url`. The desktop reads `web_url/api/runtime-config` and
   finds the API from there.

`examples/complete` is a disposable stack on run.app URLs. It can also create
a VPC and pass it in as an existing network (`create_network = true`) and test
the load balancer without a domain of your own (`sslip_domain = true`).

## Notes

- **Migrations.** The `<name>-den-migrate` job runs the same script as the Helm
  chart's pre-install/pre-upgrade Job. `terraform apply` executes it whenever
  the den-api image changes (or `migration_run_id` changes) and waits for it to
  finish before updating den-api. Run it by hand with
  `gcloud run jobs execute <migration_job_name> --region <region> --wait`.
- **Existing database.** Set `create_database = false` and `database_url`.
  For an existing Cloud SQL instance reached through the connector, also set
  `cloud_sql_connection_name` (`PROJECT:REGION:INSTANCE`) and use
  `mysql://USER:PASSWORD@localhost/DB?socket=%2Fcloudsql%2FPROJECT%3AREGION%3AINSTANCE`
  (percent-encoded). The service account needs `roles/cloudsql.client` in the
  instance's project; the module grants it in `project_id` only.
- **Existing VPC.** `network` and `subnetwork` turn on Direct VPC egress for
  both services and the job. `vpc_egress = "PRIVATE_RANGES_ONLY"` (default)
  keeps internet traffic (ghcr.io through the mirror, model providers) on
  Cloud Run's own egress; use `ALL_TRAFFIC` only with Cloud NAT on the VPC.
- **Database TLS.** The default path is Cloud Run's Cloud SQL connector: the
  instance has a public IP with no authorized networks, every connection is
  authorized by the service account's IAM role, and the connector encrypts it
  with a certificate it verifies. Prefer it.
- **Private-IP Cloud SQL.** Set `database.private_network` to a VPC that
  already has private services access (a `servicenetworking` peering), plus
  `network` and `subnetwork`. den-api then connects over TCP to the private IP
  and **you must set `database.tls_query`**: Den cannot yet verify the Cloud
  SQL server certificate (its CA is not in Node's trust store and the
  certificate does not name the IP address), so the only working choice today
  is `tls_query = "sslaccept=accept"`: encrypted, but the server certificate
  is not verified, so anyone able to intercept traffic inside your VPC could
  impersonate the database. The apply fails until you choose.
- **Existing load balancer pieces.** `ssl_certificate_ids` uses your
  certificates instead of a managed one; `load_balancer_ip_address` uses a
  reserved global address. With `restrict_ingress_to_load_balancer = true` the
  services accept only load balancer traffic and the run.app URLs are off.
- **Public access.** Den does its own sign-in, so the services allow
  unauthenticated invocations (`invoker_iam_disabled`). This does not add an
  `allUsers` IAM binding, so it also works where an organization policy
  restricts IAM members to your domain.
- **Test-only switches.** `public_access = false` keeps Cloud Run's IAM check
  on: only callers with `run.invoker` reach the services (send a Google
  identity token in `X-Serverless-Authorization`), and den-web cannot reach
  den-api, so browser sign-in does not work. `secret_manager_enabled = false`
  puts the secret values in the Cloud Run environment, readable by anyone who
  can view the service. Use them only when you cannot set IAM policies in a
  disposable test project.
- **den-web to den-api** goes through den-api's public HTTPS URL; Cloud Run
  has no private service discovery.
- **Scaling.** Defaults are 1 to 3 instances per service, with a minimum of 1
  to avoid cold starts on sign-in. Migrations no longer run at startup, so
  den-api can scale out.
- **Secrets** (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `DEN_DB_ENCRYPTION_KEY`,
  the setup code, SMTP/Resend) live in Secret Manager and in Terraform state.
  Use an encrypted remote backend (for example a GCS bucket). Losing
  `DEN_DB_ENCRYPTION_KEY` makes encrypted database values unreadable.
- **Email is optional to start.** Setup, sign-in and admin work without it.
  Without `smtp` or `resend_api_key`, member invites fail (the API returns
  `email_not_configured`) and password reset is unavailable.
- **Deletion protection** is on by default for the services, the job and
  Cloud SQL. `examples/complete` turns it off.
- **Not included yet:** OpenWork Web (den-gateway), Slack, headless
  Automations, Workbot and Redis. Use `openwork-aws-ecs` or the Helm chart for
  those today.

## Rough cost (us-central1, defaults)

About $1.50-3/day: den-api (1 vCPU / 2 GiB) and den-web (1 vCPU / 1 GiB) with
one warm instance each, a `db-f1-micro` Cloud SQL instance with 10 GB, and
Secret Manager. The load balancer adds about $0.60/day. Set `min_instances = 0`
on both services to pay only for requests, at the cost of cold starts.
