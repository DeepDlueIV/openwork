locals {
  migration_secret_env   = { for name in ["DATABASE_URL", "DEN_DB_ENCRYPTION_KEY"] : name => local.secret_env[name] }
  migration_database_url = var.migration_database_url != "" ? var.migration_database_url : local.database_url
}

# One release owner, independent of application replica count. No local-exec:
# AzAPI owns the native start. The read-only external observer below is needed
# because the ARM start LRO completes on acceptance, not on container exit.
resource "azurerm_container_app_job" "migration" {
  name                         = "${var.name}-migrate"
  resource_group_name          = var.resource_group_name
  location                     = local.location
  container_app_environment_id = local.environment_id
  workload_profile_name        = var.workload_profile_name != "" ? var.workload_profile_name : null
  replica_timeout_in_seconds   = var.migration_timeout_seconds
  replica_retry_limit          = 0
  tags                         = var.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  dynamic "identity" {
    for_each = length(local.identity_ids) > 0 ? [1] : []
    content {
      type         = "UserAssigned"
      identity_ids = local.identity_ids
    }
  }

  dynamic "secret" {
    for_each = local.migration_secret_env
    content {
      name  = secret.value
      value = secret.key == "DATABASE_URL" ? local.migration_database_url : local.secret_values[secret.key]
    }
  }
  dynamic "secret" {
    for_each = local.registry_password ? [1] : []
    content {
      name  = "registry-password"
      value = var.registry_password
    }
  }
  dynamic "registry" {
    for_each = var.registry != null ? [var.registry] : []
    content {
      server               = registry.value.server
      identity             = registry.value.identity != "" ? registry.value.identity : null
      username             = registry.value.username != "" ? registry.value.username : null
      password_secret_name = local.registry_password ? "registry-password" : null
    }
  }

  template {
    container {
      name    = "migrate"
      image   = local.den_api_image
      command = ["node", "/app/ee/packages/den-db/dist/scripts/bootstrap.js"]
      cpu     = 0.5
      memory  = "1Gi"
      dynamic "env" {
        for_each = local.environment
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.migration_secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }
    }
  }
  depends_on = [azurerm_mysql_flexible_database.this, azurerm_mysql_flexible_server_firewall_rule.azure_services]
  lifecycle {
    precondition {
      condition = var.migration_database_url == "" || try(
        regex("^mysql://[^@]+@([^?]+)[?]", var.migration_database_url)[0] == regex("^mysql://[^@]+@([^?]+)[?]", local.database_url)[0], false
      )
      error_message = "migration_database_url must target the same host, port and schema as the application database URL."
    }
  }
}

resource "terraform_data" "migration_release" {
  input = {
    image    = local.den_api_image
    database = var.create_database ? azurerm_mysql_flexible_database.this[0].id : var.existing_database_identifier
    # Retain sensitivity; changing an existing target URL must never reuse a
    # receipt for the previous database, even if its display identifier is kept.
    connection    = sha256(local.migration_database_url)
    deployment_id = var.migration_deployment_id
  }
}

resource "azapi_resource_action" "migration_start" {
  type                   = "Microsoft.App/jobs@2025-01-01"
  resource_id            = azurerm_container_app_job.migration.id
  action                 = "start"
  response_export_values = ["id", "name"]

  lifecycle {
    replace_triggered_by = [terraform_data.migration_release]
  }
}

# This observer never starts/retries/stops a Job. Unknown or failed completion
# blocks both apps, preserves the execution ID, and requires operator inspection.
data "external" "migration_completion" {
  program = ["python3", "${path.module}/scripts/wait-for-migration.py"]
  query = {
    execution_id = azapi_resource_action.migration_start.output.id
    timeout      = tostring(var.migration_timeout_seconds + 120)
  }
  lifecycle {
    postcondition {
      condition     = self.result.status == "Succeeded"
      error_message = "Migration did not complete successfully; application rollout is blocked. Inspect the retained Job execution before retrying."
    }
  }
}
