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

run "defaults_use_run_app_urls" {
  command = apply

  assert {
    condition     = output.web_url == "https://openwork-den-web-123456789012.us-central1.run.app"
    error_message = "web_url should be den-web's deterministic run.app URL."
  }
  assert {
    condition     = output.api_url == "https://openwork-den-api-123456789012.us-central1.run.app"
    error_message = "api_url should be den-api's deterministic run.app URL."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.name == "openwork-den-api" && google_cloud_run_v2_service.web.name == "openwork-den-web"
    error_message = "The service names must match the run.app URLs the env points at."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.invoker_iam_disabled && google_cloud_run_v2_service.web.invoker_iam_disabled
    error_message = "Services must be publicly reachable by default (Den does its own sign-in)."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.ingress == "INGRESS_TRAFFIC_ALL" && !google_cloud_run_v2_service.api.default_uri_disabled
    error_message = "Without domain_name the run.app URL must stay reachable."
  }
  assert {
    condition     = length(google_compute_url_map.https) == 0 && output.load_balancer_ip == null
    error_message = "No load balancer without domain_name."
  }
}

run "env_matches_cloud_run_runbook" {
  command = apply

  assert {
    condition = alltrue([
      for k, v in {
        DEN_BASE_URL                    = "https://openwork-den-web-123456789012.us-central1.run.app"
        BETTER_AUTH_URL                 = "https://openwork-den-web-123456789012.us-central1.run.app"
        DEN_API_PUBLIC_URL              = "https://openwork-den-api-123456789012.us-central1.run.app"
        DEN_MCP_RESOURCE_URL            = "https://openwork-den-api-123456789012.us-central1.run.app/mcp"
        DEN_BETTER_AUTH_TRUSTED_ORIGINS = "https://openwork-den-web-123456789012.us-central1.run.app"
        DEN_WEB_APP_HOSTS               = "openwork-den-web-123456789012.us-central1.run.app"
        DEN_API_BASE                    = "https://openwork-den-api-123456789012.us-central1.run.app"
        DEN_ORG_MODE                    = "single_org"
        DEN_SINGLE_ORG_OWNER_EMAILS     = "admin@example.com"
        DEN_BOOTSTRAP_ADMIN_EMAILS      = "admin@example.com"
        OPENWORK_DEV_MODE               = "0"
        DB_MODE                         = "mysql"
        PROVISIONER_MODE                = "stub"
      } : contains([for e in google_cloud_run_v2_service.api.template[0].containers[0].env : "${e.name}=${e.value == null ? "" : e.value}"], "${k}=${v}")
    ])
    error_message = "den-api must get the same env as packaging/cloud-run/openwork-den-api.yaml."
  }
  assert {
    condition     = !contains([for e in google_cloud_run_v2_service.api.template[0].containers[0].env : e.name], "PORT")
    error_message = "PORT is reserved by Cloud Run and must not be set."
  }
  assert {
    condition = toset([for e in google_cloud_run_v2_service.api.template[0].containers[0].env : e.name if length(e.value_source) > 0]) == toset([
      "DATABASE_URL", "BETTER_AUTH_SECRET", "DEN_DB_ENCRYPTION_KEY", "DEN_INITIAL_ADMIN_BOOTSTRAP_CODE",
    ])
    error_message = "den-api must read exactly the four generated secrets from Secret Manager."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.template[0].containers[0].ports[0].container_port == 8788 && google_cloud_run_v2_service.web.template[0].containers[0].ports[0].container_port == 3005
    error_message = "Container ports must match the images (8788 den-api, 3005 den-web)."
  }
}

run "migration_job_runs_bootstrap" {
  command = apply

  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].template[0].containers[0].args == tolist(["/app/ee/packages/den-db/dist/scripts/bootstrap.js"])
    error_message = "The migration job must run the den-db bootstrap script, like the Helm pre-upgrade Job."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].template[0].max_retries == 0
    error_message = "A failed migration must not be retried silently."
  }
  assert {
    condition     = length(google_cloud_run_v2_job.migrate.run_execution_token) == 12
    error_message = "The job must run during apply (run_execution_token)."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].template[0].containers[0].image == google_cloud_run_v2_service.api.template[0].containers[0].image
    error_message = "Migrations must use the den-api image."
  }
}

run "migration_reruns_on_new_version" {
  command = plan

  variables {
    openwork_version = "0.0.1-test"
  }

  assert {
    condition     = google_cloud_run_v2_job.migrate.run_execution_token != substr(sha256("us-central1-docker.pkg.dev/test-project/openwork-ghcr/different-ai/openwork-den-api:0.0.0-test|1"), 0, 12)
    error_message = "A new den-api image must change the migration token."
  }
}

run "images_default_to_ghcr_mirror" {
  command = apply

  assert {
    condition     = length(google_artifact_registry_repository.ghcr) == 1 && google_artifact_registry_repository.ghcr[0].remote_repository_config[0].docker_repository[0].custom_repository[0].uri == "https://ghcr.io"
    error_message = "A ghcr.io remote repository must be created by default."
  }
  assert {
    condition     = output.images.den_api == "us-central1-docker.pkg.dev/test-project/openwork-ghcr/different-ai/openwork-den-api:0.0.0-test"
    error_message = "den-api must be pulled through the mirror."
  }
}

run "custom_images_skip_mirror" {
  command = apply

  variables {
    den_api_image = "us-docker.pkg.dev/acme/openwork/openwork-den-api:1"
    den_web_image = "us-docker.pkg.dev/acme/openwork/openwork-den-web:1"
  }

  assert {
    condition     = length(google_artifact_registry_repository.ghcr) == 0
    error_message = "No mirror is needed when both images are set."
  }
  assert {
    condition     = google_cloud_run_v2_service.web.template[0].containers[0].image == var.den_web_image
    error_message = "den-web must use den_web_image."
  }
}

run "existing_network_uses_direct_vpc_egress" {
  command = apply

  variables {
    network    = "projects/test-project/global/networks/shared"
    subnetwork = "projects/test-project/regions/us-central1/subnetworks/run"
  }

  assert {
    condition = alltrue([
      for r in [google_cloud_run_v2_service.api, google_cloud_run_v2_service.web] :
      r.template[0].vpc_access[0].network_interfaces[0].subnetwork == var.subnetwork && r.template[0].vpc_access[0].egress == "PRIVATE_RANGES_ONLY"
    ])
    error_message = "Both services must egress through the given subnetwork."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].template[0].vpc_access[0].network_interfaces[0].network == var.network
    error_message = "The migration job must use the same network."
  }
}

run "network_needs_subnetwork" {
  command = plan

  variables {
    network = "projects/test-project/global/networks/shared"
  }

  expect_failures = [google_cloud_run_v2_job.migrate]
}

run "existing_service_account" {
  command = apply

  variables {
    service_account_email = "platform@test-project.iam.gserviceaccount.com"
  }

  assert {
    condition     = length(google_service_account.run) == 0 && google_cloud_run_v2_service.api.template[0].service_account == var.service_account_email
    error_message = "An existing service account must be used as is."
  }
  assert {
    condition     = google_project_iam_member.cloudsql_client[0].member == "serviceAccount:${var.service_account_email}"
    error_message = "The existing service account still needs Cloud SQL client."
  }
}

run "smtp_password_becomes_a_secret" {
  command = apply

  variables {
    smtp = { host = "smtp.example.com", username = "u", password = "p" }
  }

  assert {
    condition     = contains(keys(google_secret_manager_secret.app), "SMTP_PASS") && google_secret_manager_secret.app["SMTP_PASS"].secret_id == "openwork-den-smtp-pass"
    error_message = "SMTP_PASS must be stored in Secret Manager."
  }
  assert {
    condition     = contains([for e in google_cloud_run_v2_service.api.template[0].containers[0].env : "${e.name}=${e.value == null ? "" : e.value}"], "SMTP_HOST=smtp.example.com")
    error_message = "SMTP_HOST must be set."
  }
}

run "iam_granted_elsewhere" {
  command = apply

  variables {
    service_account_email = "platform@test-project.iam.gserviceaccount.com"
    grant_iam_roles       = false
  }

  assert {
    condition     = length(google_project_iam_member.cloudsql_client) == 0 && length(google_secret_manager_secret_iam_member.app) == 0
    error_message = "No IAM bindings when grant_iam_roles = false."
  }
  assert {
    condition     = length(google_secret_manager_secret.app) == 4
    error_message = "Secrets are still created in Secret Manager."
  }
}

run "without_secret_manager" {
  command = apply

  variables {
    secret_manager_enabled = false
  }

  assert {
    condition     = length(google_secret_manager_secret.app) == 0 && length(google_secret_manager_secret_iam_member.app) == 0
    error_message = "No Secret Manager secrets when secret_manager_enabled = false."
  }
  assert {
    condition     = length([for e in google_cloud_run_v2_service.api.template[0].containers[0].env : e.name if e.name == "DATABASE_URL" && length(e.value_source) == 0]) == 1
    error_message = "DATABASE_URL must then be a plain env var."
  }
}
