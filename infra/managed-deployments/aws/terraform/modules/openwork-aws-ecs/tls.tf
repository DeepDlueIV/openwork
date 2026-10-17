# Reviewed TLS-only exception to the pinned pre-contract managed module.
# No migration, secret-mode, resource-address or IAM changes are adopted.
data "http" "rds_ca" {
  url      = "https://truststore.pki.rds.amazonaws.com/${local.region}/${local.region}-bundle.pem"
  insecure = false
  lifecycle {
    postcondition {
      condition     = self.status_code == 200 && strcontains(self.response_body, "-----BEGIN CERTIFICATE-----")
      error_message = "The RDS CA bundle must be fetched successfully over verified HTTPS."
    }
  }
}

locals {
  # Public trust roots only, loaded before Node starts in each DB client.
  tls_setup = "printf '%s' '${base64encode(data.http.rds_ca.response_body)}' | base64 -d > /tmp/openwork-db-ca.pem; export NODE_EXTRA_CA_CERTS=/tmp/openwork-db-ca.pem; "
}
