# Self-contained test stack in an existing resource group: a new VNet with a
# Container Apps subnet and a delegated MySQL subnet, then the module, served
# on the default *.azurecontainerapps.io HTTPS hostnames (no domain needed).
# For production, pass your own subnets and, optionally, domain_name.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 5.0.0"
    }
  }
}

provider "azurerm" {
  features {
    # Disposable stack: skip the workspace's 14-day soft delete on destroy.
    log_analytics_workspace {
      permanently_delete_on_destroy = true
    }
  }
  subscription_id = var.subscription_id
  # Leave resource provider registration to the subscription owner: it needs
  # subscription-level rights (Microsoft.App, Microsoft.DBforMySQL,
  # Microsoft.Network, Microsoft.OperationalInsights).
  resource_provider_registrations = "none"
}

data "azurerm_resource_group" "this" {
  name = var.resource_group_name
}

locals {
  tags = { project = "openwork", stack = var.name }
}

resource "azurerm_virtual_network" "this" {
  name                = "${var.name}-vnet"
  resource_group_name = var.resource_group_name
  location            = data.azurerm_resource_group.this.location
  address_space       = ["10.42.0.0/16"]
  tags                = local.tags
}

resource "azurerm_subnet" "apps" {
  name                 = "container-apps"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = ["10.42.0.0/23"]

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "database" {
  count = var.private_database ? 1 : 0

  name                 = "mysql"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = ["10.42.16.0/24"]

  delegation {
    name = "mysql"
    service_delegation {
      name    = "Microsoft.DBforMySQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

module "openwork" {
  source = "../.."

  name                = var.name
  resource_group_name = var.resource_group_name
  openwork_version    = var.openwork_version
  owner_emails        = var.owner_emails
  org_name            = var.org_name
  tags                = local.tags

  container_app_environment_id = var.container_app_environment_id
  infrastructure_subnet_id     = azurerm_subnet.apps.id

  database_network = var.private_database ? {
    subnet_id          = azurerm_subnet.database[0].id
    virtual_network_id = azurerm_virtual_network.this.id
  } : null

  log_retention_days = 30
}

output "web_url" { value = module.openwork.web_url }
output "api_url" { value = module.openwork.api_url }
output "setup_url" { value = module.openwork.setup_url }
output "bootstrap_code" {
  value     = module.openwork.bootstrap_code
  sensitive = true
}
output "app_names" { value = module.openwork.app_names }
output "database_server_name" { value = module.openwork.database_server_name }
output "log_analytics_workspace_id" { value = module.openwork.log_analytics_workspace_id }
