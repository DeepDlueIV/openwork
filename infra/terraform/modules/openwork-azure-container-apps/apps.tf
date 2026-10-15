locals {
  identity_ids = distinct(compact(concat(var.user_assigned_identity_ids, [var.key_vault_identity_id])))

  registry_password = var.registry != null && nonsensitive(var.registry_password != "")
}

resource "azurerm_container_app" "api" {
  name                         = local.api_app_name
  resource_group_name          = var.resource_group_name
  container_app_environment_id = local.environment_id
  revision_mode                = "Single"
  workload_profile_name        = var.workload_profile_name != "" ? var.workload_profile_name : null
  tags                         = var.tags

  dynamic "identity" {
    for_each = length(local.identity_ids) > 0 ? [1] : []
    content {
      type         = "UserAssigned"
      identity_ids = local.identity_ids
    }
  }

  dynamic "secret" {
    for_each = local.secret_env
    content {
      name                = secret.value
      value               = contains(local.secret_env_names, secret.key) ? local.secret_values[secret.key] : null
      key_vault_secret_id = contains(local.secret_env_names, secret.key) ? null : var.extra_secrets[secret.key]
      identity            = contains(local.secret_env_names, secret.key) ? null : var.key_vault_identity_id
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

  ingress {
    external_enabled           = true
    target_port                = 8788
    transport                  = "auto"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }

    dynamic "ip_security_restriction" {
      for_each = var.allowed_ingress_cidrs
      content {
        name             = "allow-${ip_security_restriction.key}"
        action           = "Allow"
        ip_address_range = ip_security_restriction.value
      }
    }
  }

  template {
    min_replicas = var.den_api.replicas
    max_replicas = var.den_api.replicas

    container {
      name   = "den-api"
      image  = local.den_api_image
      cpu    = var.den_api.cpu
      memory = var.den_api.memory

      env {
        name  = "PORT"
        value = "8788"
      }

      dynamic "env" {
        for_each = local.environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      liveness_probe {
        transport        = "HTTP"
        port             = 8788
        path             = "/health"
        initial_delay    = 10
        interval_seconds = 30
      }

      # /ready also checks the database.
      readiness_probe {
        transport        = "HTTP"
        port             = 8788
        path             = "/ready"
        interval_seconds = 10
      }
    }
  }

  depends_on = [data.external.migration_completion]

  lifecycle {
    precondition {
      condition     = var.create_database || nonsensitive(var.database_url != "")
      error_message = "Set database_url when create_database = false."
    }
    precondition {
      condition     = !local.custom_domains || var.custom_domain_certificate != null
      error_message = "domain_name needs custom_domain_certificate (a PFX covering both hostnames)."
    }
  }
}

resource "azurerm_container_app" "web" {
  name                         = local.web_app_name
  resource_group_name          = var.resource_group_name
  container_app_environment_id = local.environment_id
  revision_mode                = "Single"
  workload_profile_name        = var.workload_profile_name != "" ? var.workload_profile_name : null
  tags                         = var.tags

  dynamic "identity" {
    for_each = length(local.identity_ids) > 0 ? [1] : []
    content {
      type         = "UserAssigned"
      identity_ids = local.identity_ids
    }
  }

  dynamic "secret" {
    for_each = local.secret_env
    content {
      name                = secret.value
      value               = contains(local.secret_env_names, secret.key) ? local.secret_values[secret.key] : null
      key_vault_secret_id = contains(local.secret_env_names, secret.key) ? null : var.extra_secrets[secret.key]
      identity            = contains(local.secret_env_names, secret.key) ? null : var.key_vault_identity_id
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

  ingress {
    external_enabled           = true
    target_port                = 3005
    transport                  = "auto"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }

    dynamic "ip_security_restriction" {
      for_each = var.allowed_ingress_cidrs
      content {
        name             = "allow-${ip_security_restriction.key}"
        action           = "Allow"
        ip_address_range = ip_security_restriction.value
      }
    }
  }

  template {
    min_replicas = var.den_web.replicas
    max_replicas = var.den_web.replicas

    container {
      name   = "den-web"
      image  = local.den_web_image
      cpu    = var.den_web.cpu
      memory = var.den_web.memory

      env {
        name  = "PORT"
        value = "3005"
      }

      dynamic "env" {
        for_each = local.environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      liveness_probe {
        transport        = "HTTP"
        port             = 3005
        path             = "/api/health"
        initial_delay    = 10
        interval_seconds = 30
      }
    }
  }

  # den-web forwards sign-in to den-api; start it once den-api has migrated.
  depends_on = [azurerm_container_app.api]
}
