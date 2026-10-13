output "web_url" {
  description = "Den web URL."
  value       = local.web_url
}

output "api_url" {
  description = "Den API public URL (DEN_API_PUBLIC_URL)."
  value       = local.api_url
}

output "setup_url" {
  description = "One-time first-administrator page. Works only while the database has no users."
  value       = "${local.web_url}/setup"
}

output "bootstrap_code" {
  description = "Code to enter at /setup with an owner email."
  value       = local.bootstrap_code
  sensitive   = true
}

output "default_hostnames" {
  description = "Default Container Apps hostnames of both apps (CNAME targets for custom domains)."
  value       = { den_api = local.default_api_host, den_web = local.default_web_host }
}

output "custom_domain_dns_records" {
  description = "DNS records Azure checks before binding domain_name and the API host: a CNAME to the app's default hostname and a TXT asuid record with the environment's verification ID."
  value = {
    for host, target in {
      (var.domain_name != "" ? var.domain_name : "<domain_name>") = local.default_web_host
      (var.domain_name != "" ? local.api_host : "<api host>")     = local.default_api_host
      } : host => {
      cname = target
      txt   = { name = "asuid.${host}", value = local.environment_verification }
    }
  }
}

output "container_app_environment_id" {
  description = "Container Apps environment the apps run in (created, or the one passed as container_app_environment_id)."
  value       = local.environment_id
}

output "app_names" {
  value = { den_api = azurerm_container_app.api.name, den_web = azurerm_container_app.web.name }
}

output "outbound_ip_addresses" {
  description = "Outbound IPs of den-api, for allowlists on anything else it must reach (an existing database, internal MCP servers)."
  value       = azurerm_container_app.api.outbound_ip_addresses
}

output "database_fqdn" {
  value = var.create_database ? azurerm_mysql_flexible_server.this[0].fqdn : null
}

output "database_server_name" {
  description = "MySQL Flexible Server name, for monitoring. Null with database_url."
  value       = var.create_database ? azurerm_mysql_flexible_server.this[0].name : null
}

output "log_analytics_workspace_id" {
  description = "Log Analytics workspace receiving the environment's logs. Null with an existing environment or without a workspace."
  value       = local.create_environment ? local.log_analytics_workspace : null
}
