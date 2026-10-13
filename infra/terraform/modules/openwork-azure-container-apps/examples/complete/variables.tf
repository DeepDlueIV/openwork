variable "subscription_id" {
  type = string
}

variable "resource_group_name" {
  description = "Existing resource group; everything is created inside it."
  type        = string
}

variable "name" {
  type    = string
  default = "openwork-test"
}

variable "openwork_version" {
  type    = string
  default = "0.18.58"
}

variable "owner_emails" {
  type = list(string)
}

variable "org_name" {
  type    = string
  default = "OpenWork"
}

variable "private_database" {
  description = "Put MySQL in a delegated subnet with a private DNS zone. false uses public access limited to Azure services (cheaper to tear down, test only)."
  type        = bool
  default     = true
}

variable "container_app_environment_id" {
  description = "Existing Container Apps environment to deploy into. Empty creates one in the new VNet."
  type        = string
  default     = ""
}
