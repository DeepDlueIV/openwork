# Offline checks (mocked azurerm provider): terraform init && terraform test

mock_provider "azurerm" {
  mock_resource "azurerm_container_app_job" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/jobs/openwork-migrate" }
  }
  mock_resource "azurerm_container_app" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/containerApps/app" }
  }
  mock_data "azurerm_resource_group" {
    defaults = { location = "eastus" }
  }
  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id                            = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/openwork-den"
      default_domain                = "happy-sky-1234.eastus.azurecontainerapps.io"
      custom_domain_verification_id = "VERIFY123"
    }
  }
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.OperationalInsights/workspaces/openwork-den-logs" }
  }
  mock_resource "azurerm_mysql_flexible_server" {
    defaults = { fqdn = "openwork-den-abc123.mysql.database.azure.com" }
  }
}

# MySQL rejects passwords without three character classes; random_password
# guarantees them with min_* settings, which a mock does not apply.
mock_provider "random" {
  mock_resource "random_password" {
    defaults = { result = "MockPassw0rdMockPassw0rdMock1234" }
  }
}

mock_provider "azapi" {
  mock_resource "azapi_resource_action" {
    defaults = { output = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/jobs/openwork-migrate/executions/test" } }
  }
}
mock_provider "external" {
  mock_data "external" {
    defaults = { result = { status = "Succeeded" } }
  }
}

variables {
  openwork_version    = "0.18.58"
  resource_group_name = "rg-test"
  owner_emails        = ["admin@example.com"]
}

run "default_stack" {
  command = apply

  assert {
    condition     = length(azurerm_container_app_environment.this) == 1 && length(azurerm_log_analytics_workspace.this) == 1
    error_message = "Expected a new environment and Log Analytics workspace by default."
  }
  assert {
    condition     = azurerm_container_app.api.container_app_environment_id == azurerm_container_app_environment.this[0].id && azurerm_container_app.web.container_app_environment_id == azurerm_container_app_environment.this[0].id
    error_message = "Both apps must run in the created environment."
  }
  assert {
    condition     = azurerm_container_app_environment.this[0].location == "eastus" && azurerm_container_app_environment.this[0].infrastructure_subnet_id == null
    error_message = "The environment should use the resource group's region and an Azure-managed network by default."
  }
  assert {
    condition     = output.web_url == "https://openwork-den-web.happy-sky-1234.eastus.azurecontainerapps.io" && output.api_url == "https://openwork-den-api.happy-sky-1234.eastus.azurecontainerapps.io"
    error_message = "Without domain_name, both URLs must be the default Container Apps hostnames."
  }
  assert {
    condition     = output.setup_url == "${output.web_url}/setup"
    error_message = "setup_url should be <web_url>/setup."
  }
  assert {
    condition     = azurerm_container_app.api.ingress[0].external_enabled && azurerm_container_app.api.ingress[0].target_port == 8788 && !azurerm_container_app.api.ingress[0].allow_insecure_connections
    error_message = "den-api must be public on HTTPS only, targeting port 8788."
  }
  assert {
    condition     = azurerm_container_app.web.ingress[0].external_enabled && azurerm_container_app.web.ingress[0].target_port == 3005 && !azurerm_container_app.web.ingress[0].allow_insecure_connections
    error_message = "den-web must be public on HTTPS only, targeting port 3005."
  }
  assert {
    condition     = azurerm_container_app.api.workload_profile_name == "Consumption" && azurerm_container_app.api.template[0].min_replicas == 1 && azurerm_container_app.api.template[0].max_replicas == 1
    error_message = "den-api should run one replica on the Consumption profile."
  }
}

run "environment_matches_helm_and_ecs" {
  command = apply

  assert {
    condition = alltrue([for k, v in {
      DEN_BASE_URL                = "https://openwork-den-web.happy-sky-1234.eastus.azurecontainerapps.io"
      BETTER_AUTH_URL             = "https://openwork-den-web.happy-sky-1234.eastus.azurecontainerapps.io"
      DEN_API_PUBLIC_URL          = "https://openwork-den-api.happy-sky-1234.eastus.azurecontainerapps.io"
      DEN_API_BASE                = "https://openwork-den-api.happy-sky-1234.eastus.azurecontainerapps.io"
      DB_MODE                     = "mysql"
      DEN_ORG_MODE                = "single_org"
      OPENWORK_DEV_MODE           = "0"
      PORT                        = "3005"
      DEN_SINGLE_ORG_OWNER_EMAILS = "admin@example.com"
    } : contains([for e in azurerm_container_app.web.template[0].container[0].env : "${e.name}=${e.value == null ? "" : e.value}"], "${k}=${v}")])
    error_message = "den-web is missing an expected environment value (public URLs must be the default hostnames)."
  }
  assert {
    condition     = !contains([for e in azurerm_container_app.web.template[0].container[0].env : e.name], "SMTP_HOST")
    error_message = "Empty values (SMTP_HOST without smtp) must not be set."
  }
  assert {
    condition = alltrue([for k in ["DATABASE_URL", "BETTER_AUTH_SECRET", "DEN_DB_ENCRYPTION_KEY", "DEN_INITIAL_ADMIN_BOOTSTRAP_CODE"] :
      contains([for e in azurerm_container_app.api.template[0].container[0].env : "${e.name}=${e.secret_name == null ? "-" : e.secret_name}"], "${k}=${lower(replace(k, "_", "-"))}")
    ])
    error_message = "den-api must read each generated secret from a Container Apps secret."
  }
  assert {
    condition     = toset([for s in azurerm_container_app.api.secret : s.name]) == toset(["database-url", "better-auth-secret", "den-db-encryption-key", "den-initial-admin-bootstrap-code"])
    error_message = "Only the four generated secrets should exist without SMTP, Resend or extra_secrets."
  }
  assert {
    condition     = length(azurerm_container_app.api.identity) == 0
    error_message = "No identity should be attached unless one is passed."
  }
}

run "migrations_run_before_den_api" {
  command = apply

  assert {
    condition     = azurerm_container_app_job.migration.template[0].container[0].command == tolist(["node", "/app/ee/packages/den-db/dist/scripts/bootstrap.js"])
    error_message = "The separate Job must run the packaged migration command."
  }
  assert {
    condition     = azurerm_container_app_job.migration.template[0].container[0].image == azurerm_container_app.api.template[0].container[0].image && endswith(azurerm_container_app.web.template[0].container[0].image, var.den_web_image_digest)
    error_message = "Migration and API must use the same immutable digest; web must also be digest-pinned."
  }
  assert {
    condition     = contains([for e in azurerm_container_app_job.migration.template[0].container[0].env : e.name], "DATABASE_URL") && contains([for e in azurerm_container_app_job.migration.template[0].container[0].env : e.name], "DEN_DB_ENCRYPTION_KEY")
    error_message = "The migration needs DATABASE_URL and DEN_DB_ENCRYPTION_KEY."
  }
  assert {
    condition     = length(azurerm_container_app.web.template[0].init_container) == 0 && length(azurerm_container_app.api.template[0].init_container) == 0 && azurerm_container_app_job.migration.replica_retry_limit == 0 && azurerm_container_app_job.migration.manual_trigger_config[0].parallelism == 1
    error_message = "Application replicas never migrate; Job parallelism is one and automatic retries are zero."
  }
}

run "public_database_by_default" {
  command = apply

  assert {
    condition     = azurerm_mysql_flexible_server.this[0].version == "8.4" && azurerm_mysql_flexible_server.this[0].sku_name == "B_Standard_B1ms"
    error_message = "Expected a Burstable MySQL 8.4 Flexible Server by default."
  }
  assert {
    condition     = azurerm_mysql_flexible_server.this[0].public_network_access == "Enabled" && azurerm_mysql_flexible_server.this[0].delegated_subnet_id == null
    error_message = "Without database_network the server uses public access."
  }
  assert {
    condition     = length(azurerm_mysql_flexible_server_firewall_rule.azure_services) == 1 && azurerm_mysql_flexible_server_firewall_rule.azure_services[0].start_ip_address == "0.0.0.0" && azurerm_mysql_flexible_server_firewall_rule.azure_services[0].end_ip_address == "0.0.0.0"
    error_message = "Public access must only allow Azure services (0.0.0.0), never the internet."
  }
  assert {
    condition     = azurerm_mysql_flexible_database.this[0].name == "openwork_den" && azurerm_mysql_flexible_database.this[0].charset == "utf8mb4"
    error_message = "Expected the openwork_den utf8mb4 database."
  }
  assert {
    condition     = length(azurerm_private_dns_zone.db) == 0
    error_message = "No private DNS zone without database_network."
  }
}

run "protected_database_and_verified_tls" {
  command = apply
  assert {
    condition     = var.deletion_protection && length(azurerm_management_lock.database) == 1 && azurerm_management_lock.database[0].lock_level == "CanNotDelete"
    error_message = "The database must have an Azure deletion lock by default."
  }
  assert {
    condition     = var.database.tls_query == "sslaccept=strict" && azurerm_mysql_flexible_server.this[0].administrator_password == null
    error_message = "The database must use verified TLS and the write-only admin password field."
  }
}

run "two_api_replicas_one_migrator" {
  command = apply
  variables {
    den_api             = { replicas = 2 }
    deletion_protection = false
    database            = { name = "exp-ow-tf-c1-proof-db" }
  }
  assert {
    condition     = azurerm_container_app.api.template[0].min_replicas == 2 && azurerm_container_app.api.template[0].max_replicas == 2 && azurerm_container_app_job.migration.manual_trigger_config[0].replica_completion_count == 1 && length(azurerm_management_lock.database) == 0
    error_message = "Scaling API must not scale the migration owner; tests can explicitly disable the database lock."
  }
  assert {
    condition     = azurerm_mysql_flexible_database.this[0].name == "exp-ow-tf-c1-proof-db"
    error_message = "Disposable stacks must be able to prefix their database schema resource without changing production defaults."
  }
  assert {
    condition     = alltrue(flatten([for envs in [azurerm_container_app.api.template[0].container[0].env, azurerm_container_app.web.template[0].container[0].env, azurerm_container_app_job.migration.template[0].container[0].env] : [for env in envs : env.value == null if contains(local.secret_env_names, env.name)]]))
    error_message = "Secrets must never be passed as plain environment values to apps or the Job."
  }
}

run "rejects_plain_secret" {
  command = plan
  variables { extra_environment = { DATABASE_URL = "not-a-secret" } }
  expect_failures = [var.extra_environment]
}

run "rejects_mutable_image" {
  command = plan
  variables { den_api_image = "ghcr.io/different-ai/openwork-den-api:latest" }
  expect_failures = [var.den_api_image]
}

run "rejects_unverified_tls" {
  command = plan
  variables { database = { tls_query = "sslaccept=accept" } }
  expect_failures = [var.database]
}

run "failed_completion_blocks_rollout" {
  command = plan
  # Preserve the preceding applied fixture's target: replacing its schema
  # would defer this read until apply and make a plan-time negative unknown.
  variables {
    database = { name = "exp-ow-tf-c1-proof-db" }
  }
  override_data {
    target = data.external.migration_completion
    values = { result = { status = "Failed" } }
  }
  expect_failures = [data.external.migration_completion]
}

run "restricts_ingress" {
  command = apply

  variables {
    allowed_ingress_cidrs = ["203.0.113.0/24"]
  }

  assert {
    condition     = azurerm_container_app.api.ingress[0].ip_security_restriction[0].ip_address_range == "203.0.113.0/24" && azurerm_container_app.web.ingress[0].ip_security_restriction[0].action == "Allow"
    error_message = "allowed_ingress_cidrs should become Allow rules on both apps."
  }
}

run "rejects_bad_name" {
  command = plan

  variables {
    name = "OpenWork_Prod"
  }

  expect_failures = [var.name]
}
