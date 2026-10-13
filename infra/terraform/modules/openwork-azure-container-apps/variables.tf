# ---------------------------------------------------------------------------
# Required
# ---------------------------------------------------------------------------

variable "openwork_version" {
  description = "Published OpenWork release, for example \"0.18.57\". Used as the tag for both images unless den_api_image / den_web_image are set."
  type        = string
}

variable "resource_group_name" {
  description = "Existing resource group to deploy into. The module creates no resource group and no role assignments."
  type        = string
}

variable "owner_emails" {
  description = "Emails allowed to claim the organization at /setup."
  type        = list(string)

  validation {
    condition     = length(var.owner_emails) > 0
    error_message = "Set at least one owner email so the first administrator can be created."
  }
}

# ---------------------------------------------------------------------------
# Naming, location and images
# ---------------------------------------------------------------------------

variable "name" {
  description = "Prefix for every resource name. Keep it short: Container App names are capped at 32 characters."
  type        = string
  default     = "openwork"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name))
    error_message = "name must be 2-20 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "location" {
  description = "Azure region. Empty uses the resource group's region."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "den_api_image" {
  description = "Full den-api image reference. Empty uses ghcr.io/different-ai/openwork-den-api:<openwork_version>. Set this to an Azure Container Registry mirror if the apps cannot reach ghcr.io (and set registry)."
  type        = string
  default     = ""
}

variable "den_web_image" {
  description = "Full den-web image reference. Empty uses ghcr.io/different-ai/openwork-den-web:<openwork_version>."
  type        = string
  default     = ""
}

variable "registry" {
  description = "Private registry for mirrored images. server: for example myregistry.azurecr.io. Authenticate with identity (a user-assigned identity ID from user_assigned_identity_ids that already has AcrPull) or with username and registry_password. Null pulls the public ghcr.io images."
  type = object({
    server   = string
    identity = optional(string, "")
    username = optional(string, "")
  })
  default = null
}

variable "registry_password" {
  description = "Password for registry.username. Stored as a Container Apps secret."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Container Apps environment and network
# ---------------------------------------------------------------------------

variable "container_app_environment_id" {
  description = "ID of an existing Container Apps environment (same subscription) to run the apps in. Empty creates <name>-den. The apps are named <app_name_prefix>den-api and <app_name_prefix>den-web."
  type        = string
  default     = ""

  validation {
    condition     = var.container_app_environment_id == "" || can(regex("^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft.App/managedEnvironments/[^/]+$", var.container_app_environment_id))
    error_message = "container_app_environment_id must be a full resource ID (/subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.App/managedEnvironments/<name>) or empty."
  }
}

variable "infrastructure_subnet_id" {
  description = "Existing subnet for a new Container Apps environment (/27 or larger, delegated to Microsoft.App/environments). Empty lets Azure manage the network; the apps then cannot reach a private database in your VNet. Ignored with container_app_environment_id."
  type        = string
  default     = ""
}

variable "internal_load_balancer_enabled" {
  description = "Create the environment with an internal load balancer only (VNet-only access; needs infrastructure_subnet_id and your own private DNS for the app hostnames). Used when creating the environment."
  type        = bool
  default     = false
}

variable "workload_profile_name" {
  description = "Workload profile the apps run on. The default Consumption profile exists in every environment the module creates. Set \"\" for an existing consumption-only (v1) environment."
  type        = string
  default     = "Consumption"
}

variable "create_log_analytics_workspace" {
  description = "Create <name>-den-logs for a new environment's logs. Set false and pass log_analytics_workspace_id to use your own, or leave that empty for no log destination."
  type        = bool
  default     = true
}

variable "log_analytics_workspace_id" {
  description = "Existing Log Analytics workspace for a new environment's logs. Used only with create_log_analytics_workspace = false."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "Retention of the created Log Analytics workspace (30-730)."
  type        = number
  default     = 30
}

variable "app_name_prefix" {
  description = "Prefix for the Container App names (den-api, den-web). Names must be unique in a resource group, so set it (for example \"openwork-\") when sharing a resource group or environment with another deployment. Changing it replaces the apps and their default hostnames."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^([a-z][a-z0-9-]{0,22})?$", var.app_name_prefix))
    error_message = "app_name_prefix must be empty or up to 23 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "user_assigned_identity_ids" {
  description = "Existing user-assigned identities attached to both apps, for Key Vault references in extra_secrets or registry pulls. The module creates no role assignments: grant them access yourself (for example Key Vault Secrets User)."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Public endpoint
# ---------------------------------------------------------------------------

variable "domain_name" {
  description = "Custom hostname for Den web, for example openwork.example.com. Empty uses the app's default https://<app>.<environment domain> hostname, which already has a trusted certificate."
  type        = string
  default     = ""

  validation {
    condition     = var.domain_name == "" || can(regex("^[a-z0-9-]+([.][a-z0-9-]+)+$", var.domain_name))
    error_message = "domain_name must be empty or a bare hostname such as openwork.example.com."
  }
}

variable "api_domain_name" {
  description = "Custom hostname for Den API. Empty uses api.<domain_name> when domain_name is set, otherwise the API app's default hostname."
  type        = string
  default     = ""
}

variable "custom_domain_certificate" {
  description = "PFX certificate (base64) covering domain_name and the API host, uploaded to the environment and bound to both apps. Required with domain_name. Create the DNS records from the custom_domain_dns_records output before you set domain_name."
  type = object({
    pfx_base64 = string
    password   = optional(string, "")
  })
  default   = null
  sensitive = true
}

variable "allowed_ingress_cidrs" {
  description = "CIDRs allowed to reach both apps. Empty allows everyone."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Organization and product flags
# ---------------------------------------------------------------------------

variable "org_name" {
  description = "Display name of the single organization."
  type        = string
  default     = "OpenWork"
}

variable "org_slug" {
  description = "URL slug of the single organization."
  type        = string
  default     = "default"
}

variable "initial_admin_bootstrap_code" {
  description = "One-time /setup code. Empty generates one (see the bootstrap_code output)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "allow_public_signup" {
  description = "Let anyone who can reach the site create an account."
  type        = bool
  default     = false
}

variable "require_email_verification" {
  description = "Require email verification at signup. Needs smtp or resend_api_key."
  type        = bool
  default     = false
}

variable "automations_enabled" {
  description = "Enable Automations."
  type        = bool
  default     = false
}

variable "dashboards_enabled" {
  description = "Enable Dashboards."
  type        = bool
  default     = false
}

variable "openwork_web_url" {
  description = "URL the dashboard's OpenWork Web button opens (DEN_WEB_OPENWORK_WEB_URL). Empty uses den-web's default (the hosted https://web.openworklabs.com)."
  type        = string
  default     = ""
}

variable "extra_environment" {
  description = "Additional plain env vars for both den-api and den-web. See ee/apps/den-api/.env.example."
  type        = map(string)
  default     = {}
}

variable "extra_secrets" {
  description = "Additional secret env vars for both apps: env var name => versionless Key Vault secret ID (https://<vault>.vault.azure.net/secrets/<name>). Read with key_vault_identity_id, which must already have access to the vault."
  type        = map(string)
  default     = {}
}

variable "key_vault_identity_id" {
  description = "User-assigned identity (also listed in user_assigned_identity_ids) the apps use to read extra_secrets from Key Vault. Required when extra_secrets is set."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------

variable "email_from" {
  description = "From address for transactional email."
  type        = string
  default     = ""
}

variable "smtp" {
  description = "SMTP relay (for example Azure Communication Services SMTP). Leave host empty to disable."
  type = object({
    host     = optional(string, "")
    port     = optional(number, 587)
    username = optional(string, "")
    password = optional(string, "")
    secure   = optional(bool, false)
  })
  default   = {}
  sensitive = true
}

variable "resend_api_key" {
  description = "Resend API key, an alternative to SMTP."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

variable "create_database" {
  description = "Create an Azure Database for MySQL Flexible Server. Set false and pass database_url to use an existing database."
  type        = bool
  default     = true
}

variable "database_url" {
  description = "mysql:// URL of an existing database, including a TLS parameter such as ?sslaccept=accept (Azure MySQL requires TLS). Used only when create_database = false."
  type        = string
  default     = ""
  sensitive   = true
}

variable "database_network" {
  description = <<-EOT
    Private access for the MySQL server the module creates. Null creates it with public
    access reachable only from Azure services (test stacks). Private access cannot be
    changed after creation.
    subnet_id: existing subnet delegated to Microsoft.DBforMySQL/flexibleServers.
    create_private_dns_zone: create <name>-den.private.mysql.database.azure.com and link
    it to virtual_network_id (the VNet of both subnets). Set false and pass
    private_dns_zone_id (a zone ending in .mysql.database.azure.com, linked to that VNet)
    to use your own.
  EOT
  type = object({
    subnet_id               = string
    virtual_network_id      = optional(string, "")
    create_private_dns_zone = optional(bool, true)
    private_dns_zone_id     = optional(string, "")
  })
  default = null
}

variable "database" {
  description = "MySQL Flexible Server settings."
  type = object({
    sku_name              = optional(string, "B_Standard_B1ms")
    version               = optional(string, "8.4")
    storage_gb            = optional(number, 20)
    backup_retention_days = optional(number, 7)
    zone                  = optional(string)
    high_availability     = optional(string, "") # SameZone or ZoneRedundant; needs a General Purpose SKU
    tls_query             = optional(string, "sslaccept=accept")
  })
  default = {}

  validation {
    condition     = contains(["", "SameZone", "ZoneRedundant"], var.database.high_availability)
    error_message = "database.high_availability must be empty, SameZone or ZoneRedundant."
  }
}

# ---------------------------------------------------------------------------
# Apps
# ---------------------------------------------------------------------------

variable "den_api" {
  description = "den-api size and replica count. cpu and memory must be a valid Container Apps combination (for example 1 and \"2Gi\"). Keep replicas = 1 until you have confirmed migrations: each replica runs them on start."
  type = object({
    cpu      = optional(number, 1)
    memory   = optional(string, "2Gi")
    replicas = optional(number, 1)
  })
  default = {}
}

variable "den_web" {
  description = "den-web size and replica count."
  type = object({
    cpu      = optional(number, 0.5)
    memory   = optional(string, "1Gi")
    replicas = optional(number, 1)
  })
  default = {}
}
