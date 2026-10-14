# Cloud SQL for MySQL ---------------------------------------------------------

locals {
  db_private = var.create_database && var.database.private_network != ""

  # Cloud Run mounts the Cloud SQL connector socket at /cloudsql/<connection name>.
  cloud_sql_connection_name = var.create_database ? (local.db_private ? "" : google_sql_database_instance.this[0].connection_name) : var.cloud_sql_connection_name

  database_url = !var.create_database ? var.database_url : (
    local.db_private ? format(
      "mysql://%s:%s@%s:3306/%s%s",
      google_sql_user.openwork[0].name,
      random_password.db[0].result,
      google_sql_database_instance.this[0].private_ip_address,
      google_sql_database.den[0].name,
      "?${var.database.tls_query}",
      ) : format(
      # The host is required by URL parsing; mysql2 connects to socketPath.
      "mysql://%s:%s@localhost/%s?socket=%s",
      google_sql_user.openwork[0].name,
      random_password.db[0].result,
      google_sql_database.den[0].name,
      urlencode("/cloudsql/${google_sql_database_instance.this[0].connection_name}"),
    )
  )
}

resource "random_password" "db" {
  count = var.create_database ? 1 : 0

  length  = 32
  special = false # embedded in DATABASE_URL
}

resource "google_sql_database_instance" "this" {
  count = var.create_database ? 1 : 0

  project             = var.project_id
  name                = "${var.name}-den"
  region              = var.region
  database_version    = var.database.database_version
  deletion_protection = var.database.deletion_protection

  settings {
    tier              = var.database.tier
    edition           = var.database.edition
    availability_type = var.database.availability_type
    disk_size         = var.database.disk_size_gb
    disk_autoresize   = true
    user_labels       = var.labels

    ip_configuration {
      # Public IP is used only by the Cloud Run connector (IAM-authorized,
      # encrypted); no authorized networks are added.
      ipv4_enabled    = !local.db_private
      private_network = local.db_private ? var.database.private_network : null
    }

    backup_configuration {
      enabled            = var.database.backup_enabled
      binary_log_enabled = var.database.backup_enabled
    }
  }

  lifecycle {
    precondition {
      condition     = !local.db_private || var.network != ""
      error_message = "database.private_network needs network and subnetwork so Cloud Run can reach the private IP."
    }
    # No silent default: on the private-IP path den-api speaks TCP to the
    # instance and cannot verify the Cloud SQL server CA (it is not in Node's
    # trust store and the certificate does not name the IP), so the operator
    # must opt in to a TLS setting explicitly.
    precondition {
      condition     = !local.db_private || var.database.tls_query != ""
      error_message = "database.private_network needs an explicit database.tls_query. Den cannot verify the Cloud SQL server certificate over a private IP: use the default connector path (leave private_network empty) for verified TLS, or set tls_query = \"sslaccept=accept\" to accept encrypted but unverified TLS inside your VPC."
    }
  }
}

resource "google_sql_database" "den" {
  count = var.create_database ? 1 : 0

  project  = var.project_id
  instance = google_sql_database_instance.this[0].name
  name     = "openwork_den"
}

resource "google_sql_user" "openwork" {
  count = var.create_database ? 1 : 0

  project  = var.project_id
  instance = google_sql_database_instance.this[0].name
  name     = "openwork"
  host     = "%"
  password = random_password.db[0].result
}
