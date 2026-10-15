# Reuse of an existing network, environment and database (mocked azurerm provider).

mock_provider "azurerm" {
  mock_resource "azurerm_container_app_job" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/jobs/openwork-migrate" }
  }
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.OperationalInsights/workspaces/openwork-den-logs" }
  }
  mock_resource "azurerm_container_app" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/containerApps/app" }
  }
  mock_data "azurerm_resource_group" {
    defaults = { location = "eastus" }
  }
  mock_data "azurerm_container_app_environment" {
    defaults = {
      default_domain                = "shared-env-9876.westeurope.azurecontainerapps.io"
      custom_domain_verification_id = "VERIFY987"
    }
  }
  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id                            = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/openwork-den"
      default_domain                = "happy-sky-1234.eastus.azurecontainerapps.io"
      custom_domain_verification_id = "VERIFY123"
    }
  }
  mock_resource "azurerm_private_dns_zone" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.Network/privateDnsZones/openwork-den.private.mysql.database.azure.com" }
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

run "existing_subnets_private_database" {
  command = apply

  variables {
    infrastructure_subnet_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/vnet/subnets/apps"
    database_network = {
      subnet_id          = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/vnet/subnets/mysql"
      virtual_network_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/vnet"
    }
  }

  assert {
    condition     = azurerm_container_app_environment.this[0].infrastructure_subnet_id == var.infrastructure_subnet_id
    error_message = "The new environment must use the existing infrastructure subnet."
  }
  assert {
    condition     = azurerm_mysql_flexible_server.this[0].delegated_subnet_id == var.database_network.subnet_id && azurerm_mysql_flexible_server.this[0].public_network_access == "Disabled"
    error_message = "With database_network the server must be private."
  }
  assert {
    condition     = length(azurerm_private_dns_zone.db) == 1 && azurerm_private_dns_zone_virtual_network_link.db[0].virtual_network_id == var.database_network.virtual_network_id && azurerm_mysql_flexible_server.this[0].private_dns_zone_id == azurerm_private_dns_zone.db[0].id
    error_message = "The module should create a private DNS zone linked to the VNet and use it for the server."
  }
  assert {
    condition     = endswith(azurerm_private_dns_zone.db[0].name, ".mysql.database.azure.com")
    error_message = "Azure requires the private DNS zone to end in .mysql.database.azure.com."
  }
  assert {
    condition     = length(azurerm_mysql_flexible_server_firewall_rule.azure_services) == 0
    error_message = "A private server needs no firewall rule."
  }
}

run "existing_private_dns_zone" {
  command = apply

  variables {
    database_network = {
      subnet_id               = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/vnet/subnets/mysql"
      create_private_dns_zone = false
      private_dns_zone_id     = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/privateDnsZones/corp.private.mysql.database.azure.com"
    }
  }

  assert {
    condition     = length(azurerm_private_dns_zone.db) == 0 && azurerm_mysql_flexible_server.this[0].private_dns_zone_id == var.database_network.private_dns_zone_id
    error_message = "An existing private DNS zone must be used as is."
  }
}

run "private_database_needs_vnet_for_new_zone" {
  command = plan

  variables {
    database_network = { subnet_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/vnet/subnets/mysql" }
  }

  expect_failures = [azurerm_private_dns_zone_virtual_network_link.db]
}

run "own_private_dns_zone_needs_its_id" {
  command = plan

  variables {
    database_network = {
      subnet_id               = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/vnet/subnets/mysql"
      create_private_dns_zone = false
    }
  }

  expect_failures = [azurerm_mysql_flexible_server.this]
}

run "existing_environment" {
  command = apply

  variables {
    container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/platform/providers/Microsoft.App/managedEnvironments/shared"
    app_name_prefix              = "ow-"
  }

  assert {
    condition     = length(azurerm_container_app_environment.this) == 0 && length(azurerm_log_analytics_workspace.this) == 0
    error_message = "No environment or workspace should be created with container_app_environment_id."
  }
  assert {
    condition     = data.azurerm_container_app_environment.existing[0].name == "shared" && data.azurerm_container_app_environment.existing[0].resource_group_name == "platform"
    error_message = "The existing environment's name and resource group must come from its ID."
  }
  assert {
    condition     = azurerm_container_app.api.container_app_environment_id == var.container_app_environment_id && azurerm_container_app.web.container_app_environment_id == var.container_app_environment_id
    error_message = "Both apps must run in the existing environment."
  }
  assert {
    condition     = azurerm_container_app.api.name == "ow-openwork-den-api" && output.web_url == "https://ow-openwork-den-web.shared-env-9876.westeurope.azurecontainerapps.io"
    error_message = "app_name_prefix should prefix the app names and their default hostnames in the existing environment."
  }
}

run "rejects_environment_name" {
  command = plan

  variables {
    container_app_environment_id = "shared"
  }

  expect_failures = [var.container_app_environment_id]
}

run "existing_database" {
  command = apply

  variables {
    create_database        = false
    database_url           = "mysql://openwork:secret@db.example.com:3306/openwork_den?sslaccept=strict"
    migration_database_url = "mysql://migrator:secret@db.example.com:3306/openwork_den?sslaccept=strict"
  }

  assert {
    condition     = length(azurerm_mysql_flexible_server.this) == 0 && length(azurerm_mysql_flexible_database.this) == 0 && length(azurerm_mysql_flexible_server_firewall_rule.azure_services) == 0
    error_message = "No MySQL resources should be created with an existing database."
  }
  assert {
    condition     = output.database_fqdn == null && contains([for s in azurerm_container_app.api.secret : s.name], "database-url")
    error_message = "The existing database_url must still reach den-api as a secret."
  }
  assert {
    condition     = terraform_data.migration_release.input.connection == sha256(var.migration_database_url)
    error_message = "Changing the migration database target must invalidate the old migration receipt even if its display identifier stays unchanged."
  }
  assert {
    condition     = anytrue([for secret in azurerm_container_app_job.migration.secret : secret.name == "database-url" && secret.value == var.migration_database_url]) && anytrue([for secret in azurerm_container_app.api.secret : secret.name == "database-url" && secret.value == var.database_url]) && !contains([for secret in azurerm_container_app_job.migration.secret : secret.name], "better-auth-secret")
    error_message = "A separate DDL principal must reach only the Job; application auth secrets must not reach the Job."
  }
}

run "rejects_migration_for_another_database" {
  command = plan
  variables {
    create_database        = false
    database_url           = "mysql://app:secret@db.example.com:3306/openwork_den?sslaccept=strict"
    migration_database_url = "mysql://migrator:secret@other.example.com:3306/openwork_den?sslaccept=strict"
  }
  expect_failures = [azurerm_container_app_job.migration]
}

run "existing_database_needs_url" {
  command = plan

  variables {
    create_database = false
  }

  expect_failures = [azurerm_container_app.api]
}
