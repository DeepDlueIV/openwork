# openwork-azure-container-apps (Terraform, draft)

Runs a private, single-organization OpenWork control plane (Den) on **Azure
Container Apps**, without Kubernetes:

| Piece | Azure resource |
| --- | --- |
| Container Apps environment | `<name>-den` (workload profiles, Consumption), or your existing environment (`container_app_environment_id`) |
| Den API (`ghcr.io/different-ai/openwork-den-api`, port 8788) | Container App `<name>-den-api` |
| Den web (`ghcr.io/different-ai/openwork-den-web`, port 3005) | Container App `<name>-den-web` |
| Database migrations | Init container in each den-api revision; den-api starts only if it succeeds |
| MySQL 8.4 | Azure Database for MySQL Flexible Server, private in your delegated subnet (or bring your own `database_url`) |
| HTTPS | Container Apps ingress: the default `https://<app>.<environment domain>` hostnames, or your `domain_name` and `api.<domain_name>` with your certificate |
| Secrets | Container Apps secrets; optional Key Vault references (`extra_secrets`) |
| Logs | Log Analytics workspace `<name>-den-logs` (or yours) |

It sets the same environment the [`openwork-ee` Helm chart](../../../../packaging/helm/openwork-ee)
and the [`openwork-aws-ecs`](../openwork-aws-ecs) module set, so the chart's
README and `ee/apps/den-api/.env.example` document every setting you can add
through `extra_environment`.

> **Status: draft, not yet applied on Azure.** `terraform validate` and the
> mocked `terraform test` suite pass with Terraform 1.16 and OpenTofu 1.11 on
> azurerm 5.0 and 5.9, and `terraform plan` of `examples/complete` succeeds
> against a real subscription. It has not been applied end to end yet: HTTPS,
> migrations, `/setup` and sign-in on Azure are untested, as are custom
> domains, Key Vault references, private registries and existing
> environments. Pin it to a commit and expect inputs to change.

The AWS module's optional pieces (OpenWork Web, the headless runner, Workbot,
Slack, Redis) are not in this module yet.

## Before you start

- An existing **resource group**. The module creates no resource group and
  **no role assignments**, so `Contributor` on that resource group is enough.
- **Resource providers** registered on the subscription (needs
  subscription-level rights, once per subscription):

  ```bash
  for ns in Microsoft.App Microsoft.DBforMySQL Microsoft.Network Microsoft.OperationalInsights; do
    az provider register --namespace "$ns"
  done
  ```

- **Network** (recommended): a VNet with
  - a subnet for the Container Apps environment (`infrastructure_subnet_id`),
    `/27` or larger, delegated to `Microsoft.App/environments`;
  - a subnet for MySQL (`database_network.subnet_id`), delegated to
    `Microsoft.DBforMySQL/flexibleServers`, with nothing else in it.

  Without them, Azure manages the app network and MySQL uses public access
  limited to Azure services. That is fine for a disposable test, not for
  production. Private access cannot be added to an existing server later.
- The apps pull images from `ghcr.io` and call model providers, so they need
  outbound internet access. To avoid `ghcr.io`, mirror the images to Azure
  Container Registry and set `den_api_image`, `den_web_image` and `registry`.
- **No domain needed to start.** Each app gets a default HTTPS hostname with a
  Microsoft-managed certificate. HTTPS is required: Den refuses to start with
  a plain-HTTP public URL outside dev mode.

## Usage

```hcl
module "openwork" {
  source = "github.com/different-ai/openwork//infra/terraform/modules/openwork-azure-container-apps?ref=<commit>"

  openwork_version    = "0.18.58"
  owner_emails        = ["admin@example.com"]
  org_name            = "Example Co"
  resource_group_name = "openwork-prod"

  infrastructure_subnet_id = azurerm_subnet.apps.id
  database_network = {
    subnet_id          = azurerm_subnet.mysql.id
    virtual_network_id = azurerm_virtual_network.this.id # links the private DNS zone
  }

  # Optional
  container_app_environment_id = "" # empty creates <name>-den
  email_from                   = "OpenWork <no-reply@example.com>"
  smtp = {
    host     = "smtp.azurecomm.net"
    username = var.smtp_user
    password = var.smtp_password
  }
}
```

After `terraform apply`:

1. `terraform output -raw bootstrap_code` (generated unless you set
   `initial_admin_bootstrap_code`).
2. Open the `setup_url` output, enter an owner email and that code, and
   create the first administrator. `/setup` works once, while the database
   has no users.
3. In OpenWork Desktop, set **Cloud control plane URL** (on the sign-in
   screen) to `web_url`. The desktop reads `web_url/api/runtime-config` and
   finds the API from there.

`examples/complete` is a disposable stack in an existing resource group: it
creates a VNet with both subnets and serves the default hostnames.

## Notes

- **Default hostnames.** Without `domain_name`, Den web is
  `https://<name>-den-web.<environment domain>` and Den API is
  `https://<name>-den-api.<environment domain>`. Den would normally derive the
  API as `api.<web host>`, so the module sets `DEN_API_PUBLIC_URL` on both apps.
  Sign-in cookies stay on the web host (den-web forwards sign-in to den-api),
  so the two sibling hostnames work.
- **Custom domains.** Azure checks DNS before it binds a hostname. Apply once
  without `domain_name`, create the records listed in the
  `custom_domain_dns_records` output (a CNAME to each app's default hostname
  and an `asuid.<host>` TXT record), then set `domain_name` and
  `custom_domain_certificate` (a PFX covering both hostnames) and apply again.
  Azure-managed certificates for custom domains are not supported by this
  module yet.
- **Existing environment.** Set `container_app_environment_id` to run the two
  apps in an environment you already have; the module then creates no
  environment or Log Analytics workspace. App names must be unique in the
  resource group, so set `app_name_prefix` when another deployment shares it.
  For a consumption-only (v1) environment, set `workload_profile_name = ""`.
  The environment must be able to reach your database.
- **Existing database.** Set `create_database = false` and `database_url`.
  Azure MySQL requires TLS, so include `?sslaccept=accept` (or a stricter
  value).
- **Secrets** (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `DEN_DB_ENCRYPTION_KEY`,
  the setup code, SMTP/Resend) are Container Apps secrets and live in
  Terraform state. Use an encrypted remote backend. Losing
  `DEN_DB_ENCRYPTION_KEY` makes encrypted database values unreadable.
- **Key Vault.** For secrets you keep in Key Vault (SSO, for example), pass
  `extra_secrets` (env var name => versionless secret ID), a user-assigned
  identity in `user_assigned_identity_ids` and `key_vault_identity_id`. Grant
  that identity `Key Vault Secrets User` on the vault yourself; the module
  never creates role assignments.
- **Migrations** run in each den-api replica before the app starts, like the
  Helm chart's pre-upgrade Job. They are idempotent but not locked, so keep
  `den_api.replicas = 1` until you need more.
- **MySQL TLS** defaults to `sslaccept=accept` (encrypted, certificate not
  verified), the same as the AWS module and the AKS runbook. Set
  `database.tls_query = "sslaccept=strict"` to verify the certificate.
- **Email is optional to start.** Setup, sign-in and admin work without it.
  Without `smtp` or `resend_api_key`, member invites and password reset are
  unavailable. To add a second user during a test, configure email or set
  `allow_public_signup = true` for a while.
- **Anything else** (SSO, proxies, observability): add env vars with
  `extra_environment` and secrets with `extra_secrets`.

## Tests

```bash
terraform init -backend=false && terraform validate && terraform test   # or tofu
```

The tests mock the azurerm provider; they need no Azure account.

## Rough cost (East US list prices, defaults; not measured)

About $2-4/day: den-api (1 vCPU, 2 GiB) and den-web (0.5 vCPU, 1 GiB) kept at
one replica each on the Consumption profile (less when idle), a Burstable
B1ms MySQL server with 20 GB (about $0.50/day), and Log Analytics ingestion.
