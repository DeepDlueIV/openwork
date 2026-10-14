variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
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

variable "create_network" {
  description = "Create a VPC and subnet and pass them to the module for Direct VPC egress."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Hostname for Den web behind the HTTPS load balancer; api.<domain_name> is used for the API. Empty uses run.app URLs."
  type        = string
  default     = ""
}

variable "sslip_domain" {
  description = "Test the load balancer on <ip>.sslip.io instead of domain_name."
  type        = bool
  default     = false
}

variable "service_account_email" {
  description = "Existing service account for the services. Empty creates one."
  type        = string
  default     = ""
}

variable "grant_iam_roles" {
  description = "Let the module grant Cloud SQL client and secret access (needs IAM admin rights)."
  type        = bool
  default     = true
}

variable "public_access" {
  description = "Let browsers reach the services without Google IAM (needs run.services.setIamPolicy)."
  type        = bool
  default     = true
}
