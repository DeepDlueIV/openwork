# Offline checks (mocked Google provider): terraform init && terraform test

mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
  mock_resource "google_sql_database_instance" {
    defaults = { connection_name = "test-project:us-central1:openwork-den", private_ip_address = "10.10.0.5" }
  }
  mock_resource "google_secret_manager_secret_version" {
    defaults = { version = "1" }
  }
  mock_resource "google_service_account" {
    defaults = { email = "openwork-den-run@test-project.iam.gserviceaccount.com" }
  }
  mock_resource "google_compute_global_address" {
    defaults = { address = "34.120.0.10" }
  }
  mock_resource "google_compute_backend_service" {
    defaults = { id = "projects/test-project/global/backendServices/openwork" }
  }
  mock_resource "google_compute_managed_ssl_certificate" {
    defaults = { id = "projects/test-project/global/sslCertificates/openwork-den" }
  }
}

mock_provider "random" {}

variables {
  project_id       = "test-project"
  openwork_version = "0.0.0-test"
  owner_emails     = ["admin@example.com"]
}

run "creates_cloud_sql_mysql_84" {
  command = apply

  assert {
    condition     = google_sql_database_instance.this[0].database_version == "MYSQL_8_4" && google_sql_database_instance.this[0].settings[0].ip_configuration[0].ipv4_enabled
    error_message = "Default database is Cloud SQL for MySQL 8.4 reached through the connector."
  }
  assert {
    condition     = length(google_sql_database_instance.this[0].settings[0].ip_configuration[0].authorized_networks) == 0
    error_message = "No authorized networks: only the IAM-authorized connector may connect."
  }
  assert {
    condition     = google_sql_database.den[0].name == "openwork_den" && google_sql_user.openwork[0].name == "openwork"
    error_message = "Database and user names must match the runbook."
  }
  assert {
    condition     = toset(google_cloud_run_v2_service.api.template[0].volumes[0].cloud_sql_instance[0].instances) == toset(["test-project:us-central1:openwork-den"])
    error_message = "den-api must mount the Cloud SQL socket."
  }
  assert {
    condition     = toset(google_cloud_run_v2_job.migrate.template[0].template[0].volumes[0].cloud_sql_instance[0].instances) == toset(["test-project:us-central1:openwork-den"])
    error_message = "The migration job must mount the Cloud SQL socket."
  }
  assert {
    condition     = startswith(nonsensitive(google_secret_manager_secret_version.app["DATABASE_URL"].secret_data), "mysql://openwork:") && endswith(nonsensitive(google_secret_manager_secret_version.app["DATABASE_URL"].secret_data), "@localhost/openwork_den?socket=%2Fcloudsql%2Ftest-project%3Aus-central1%3Aopenwork-den")
    error_message = "DATABASE_URL must use the percent-encoded Cloud SQL socket."
  }
}

run "private_ip_database_uses_tcp" {
  command = apply

  variables {
    network    = "projects/test-project/global/networks/shared"
    subnetwork = "projects/test-project/regions/us-central1/subnetworks/run"
    database   = { private_network = "projects/test-project/global/networks/shared", tls_query = "sslaccept=accept" }
  }

  assert {
    condition     = !google_sql_database_instance.this[0].settings[0].ip_configuration[0].ipv4_enabled
    error_message = "private_network must give the instance a private IP only."
  }
  assert {
    condition     = length(google_cloud_run_v2_service.api.template[0].volumes) == 0
    error_message = "No socket mount for a private-IP database."
  }
  assert {
    condition     = endswith(nonsensitive(google_secret_manager_secret_version.app["DATABASE_URL"].secret_data), "@10.10.0.5:3306/openwork_den?sslaccept=accept")
    error_message = "DATABASE_URL must use the private IP with the TLS setting the operator chose."
  }
}

run "private_ip_database_needs_explicit_tls_choice" {
  command = plan

  variables {
    network    = "projects/test-project/global/networks/shared"
    subnetwork = "projects/test-project/regions/us-central1/subnetworks/run"
    database   = { private_network = "projects/test-project/global/networks/shared" }
  }

  expect_failures = [google_sql_database_instance.this]
}

run "connector_path_has_no_tls_query" {
  command = apply

  assert {
    condition     = !strcontains(nonsensitive(google_secret_manager_secret_version.app["DATABASE_URL"].secret_data), "sslaccept")
    error_message = "The default connector path must not add an unverified TLS setting; the connector secures the connection."
  }
}

run "private_ip_database_needs_network" {
  command = plan

  variables {
    database = { private_network = "projects/test-project/global/networks/shared", tls_query = "sslaccept=accept" }
  }

  expect_failures = [google_sql_database_instance.this]
}

run "existing_cloud_sql_database" {
  command = apply

  variables {
    create_database           = false
    database_url              = "mysql://u:p@localhost/den?socket=%2Fcloudsql%2Fother%3Aus-central1%3Ashared"
    cloud_sql_connection_name = "other:us-central1:shared"
  }

  assert {
    condition     = length(google_sql_database_instance.this) == 0 && length(google_sql_user.openwork) == 0
    error_message = "No Cloud SQL instance with an existing database."
  }
  assert {
    condition     = toset(google_cloud_run_v2_service.api.template[0].volumes[0].cloud_sql_instance[0].instances) == toset(["other:us-central1:shared"])
    error_message = "The existing instance must be mounted."
  }
  assert {
    condition     = nonsensitive(google_secret_manager_secret_version.app["DATABASE_URL"].secret_data == var.database_url)
    error_message = "database_url must be stored as given."
  }
}

run "existing_external_database" {
  command = apply

  variables {
    create_database = false
    database_url    = "mysql://u:p@db.example.com:3306/den?sslaccept=strict"
  }

  assert {
    condition     = length(google_cloud_run_v2_service.api.template[0].volumes) == 0 && output.cloud_sql_connection_name == ""
    error_message = "No socket mount for a non-Cloud SQL database."
  }
}

run "existing_database_needs_url" {
  command = plan

  variables {
    create_database = false
  }

  expect_failures = [google_cloud_run_v2_job.migrate]
}
