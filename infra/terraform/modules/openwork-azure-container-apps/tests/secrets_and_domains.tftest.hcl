# Key Vault references, email secrets and custom domains (mocked azurerm provider).

mock_provider "azurerm" {
  mock_resource "azurerm_container_app_job" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/jobs/openwork-migrate" }
  }
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.OperationalInsights/workspaces/openwork-den-logs" }
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
  mock_resource "azurerm_container_app" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/containerApps/app" }
  }
  mock_resource "azurerm_container_app_environment_certificate" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/openwork-den/certificates/openwork-den" }
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

run "key_vault_extra_secrets" {
  command = apply

  variables {
    user_assigned_identity_ids = ["/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/openwork"]
    key_vault_identity_id      = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/openwork"
    extra_secrets = {
      DEN_SSO_CLIENT_SECRET = "https://corp-vault.vault.azure.net/secrets/openwork-sso"
    }
  }

  assert {
    condition = anytrue([for s in azurerm_container_app.api.secret :
      s.name == "den-sso-client-secret" && s.key_vault_secret_id == "https://corp-vault.vault.azure.net/secrets/openwork-sso" && s.identity == var.key_vault_identity_id
    ])
    error_message = "extra_secrets must become Key Vault references read with key_vault_identity_id."
  }
  assert {
    condition     = contains([for e in azurerm_container_app.web.template[0].container[0].env : "${e.name}=${e.secret_name == null ? "-" : e.secret_name}"], "DEN_SSO_CLIENT_SECRET=den-sso-client-secret")
    error_message = "Both apps must expose each extra secret as an env var."
  }
  assert {
    condition     = azurerm_container_app.api.identity[0].type == "UserAssigned" && length(azurerm_container_app.api.identity[0].identity_ids) == 1
    error_message = "The identity must be attached once, even when listed twice."
  }
}

run "extra_secrets_need_identity" {
  command = plan

  variables {
    extra_secrets = { DEN_SSO_CLIENT_SECRET = "https://corp-vault.vault.azure.net/secrets/openwork-sso" }
  }

  expect_failures = [var.extra_secrets]
}

run "email_secrets" {
  command = apply

  variables {
    email_from = "OpenWork <no-reply@example.com>"
    smtp = {
      host     = "smtp.azurecomm.net"
      username = "openwork"
      password = "smtp-password"
    }
  }

  assert {
    condition     = contains([for s in azurerm_container_app.api.secret : s.name], "smtp-pass") && !contains([for s in azurerm_container_app.api.secret : s.name], "resend-api-key")
    error_message = "The SMTP password should be a secret; an unset Resend key should not."
  }
  assert {
    condition     = contains([for e in azurerm_container_app.api.template[0].container[0].env : "${e.name}=${e.value == null ? "" : e.value}"], "SMTP_HOST=smtp.azurecomm.net")
    error_message = "SMTP_HOST should be a plain env var."
  }
}

run "custom_domains" {
  command = apply

  variables {
    domain_name = "openwork.example.com"
    custom_domain_certificate = {
      pfx_base64 = "UEZYLXRlc3Q="
      password   = "pfx-password"
    }
  }

  assert {
    condition     = output.web_url == "https://openwork.example.com" && output.api_url == "https://api.openwork.example.com"
    error_message = "With domain_name, Den should use the custom hostnames."
  }
  assert {
    condition     = azurerm_container_app_custom_domain.web[0].name == "openwork.example.com" && azurerm_container_app_custom_domain.api[0].name == "api.openwork.example.com"
    error_message = "Both custom hostnames must be bound."
  }
  assert {
    condition     = azurerm_container_app_custom_domain.api[0].container_app_environment_certificate_id == azurerm_container_app_environment_certificate.this[0].id && azurerm_container_app_custom_domain.api[0].certificate_binding_type == "SniEnabled"
    error_message = "Both bindings should use the uploaded certificate with SNI."
  }
  assert {
    condition     = contains([for e in azurerm_container_app.api.template[0].container[0].env : "${e.name}=${e.value == null ? "" : e.value}"], "DEN_API_BASE=https://openwork-den-api.happy-sky-1234.eastus.azurecontainerapps.io")
    error_message = "den-web should keep calling den-api on its default HTTPS hostname."
  }
  assert {
    condition     = output.custom_domain_dns_records["api.openwork.example.com"].cname == "openwork-den-api.happy-sky-1234.eastus.azurecontainerapps.io" && output.custom_domain_dns_records["openwork.example.com"].txt.name == "asuid.openwork.example.com" && output.custom_domain_dns_records["openwork.example.com"].txt.value == "VERIFY123"
    error_message = "custom_domain_dns_records should list the CNAME and asuid TXT records Azure checks."
  }
}

run "custom_domain_needs_certificate" {
  command = plan

  variables {
    domain_name = "openwork.example.com"
  }

  expect_failures = [azurerm_container_app.api]
}
