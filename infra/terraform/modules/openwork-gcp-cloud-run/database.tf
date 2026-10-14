# Cloud SQL for MySQL ---------------------------------------------------------

locals {
  # Cloud Run mounts the Cloud SQL connector socket at /cloudsql/<connection name>.
  cloud_sql_connection_name = var.create_database ? google_sql_database_instance.this[0].connection_name : var.cloud_sql_connection_name

  # The connector authorizes each connection with the service account's IAM
  # role and encrypts it with a certificate it verifies, so no TLS query.
  database_url = !var.create_database ? var.database_url : format(
    # The host is required by URL parsing; mysql2 connects to socketPath.
    "mysql://%s:%s@localhost/%s?socket=%s",
    google_sql_user.openwork[0].name,
    random_password.db[0].result,
    google_sql_database.den[0].name,
    urlencode("/cloudsql/${google_sql_database_instance.this[0].connection_name}"),
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
      # verified TLS); no authorized networks are added.
      ipv4_enabled = true
    }

    backup_configuration {
      enabled            = var.database.backup_enabled
      binary_log_enabled = var.database.backup_enabled
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
