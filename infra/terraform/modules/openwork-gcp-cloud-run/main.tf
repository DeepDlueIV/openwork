data "google_project" "this" {
  project_id = var.project_id
}

locals {
  custom_domain = var.domain_name != ""
  api_host      = var.api_domain_name != "" ? var.api_domain_name : "api.${var.domain_name}"

  api_service_name = "${var.name}-den-api"
  web_service_name = "${var.name}-den-web"
  migrate_job_name = "${var.name}-den-migrate"

  # Cloud Run's deterministic default URL is https://<service>-<project number>.<region>.run.app,
  # so both origins are known before the services exist (no second apply).
  run_app_suffix = "${data.google_project.this.number}.${var.region}.run.app"
  web_url        = local.custom_domain ? "https://${var.domain_name}" : "https://${local.web_service_name}-${local.run_app_suffix}"
  api_url        = local.custom_domain ? "https://${local.api_host}" : "https://${local.api_service_name}-${local.run_app_suffix}"
  web_host       = trimprefix(local.web_url, "https://")

  mirror_enabled = var.create_image_mirror && (var.den_api_image == "" || var.den_web_image == "")
  mirror_path    = "${var.region}-docker.pkg.dev/${var.project_id}/${var.name}-ghcr/different-ai"
  # Published images are pinned by digest: a tag can be moved upstream.
  den_api_ref   = var.image_digests.den_api != "" ? "@${var.image_digests.den_api}" : ":${var.openwork_version}"
  den_web_ref   = var.image_digests.den_web != "" ? "@${var.image_digests.den_web}" : ":${var.openwork_version}"
  den_api_image = var.den_api_image != "" ? var.den_api_image : "${local.mirror_path}/openwork-den-api${local.den_api_ref}"
  den_web_image = var.den_web_image != "" ? var.den_web_image : "${local.mirror_path}/openwork-den-web${local.den_web_ref}"

  # Unpinned published images need an explicit opt-in.
  images_pinned = var.allow_mutable_image_tags || ((var.den_api_image != "" || var.image_digests.den_api != "") && (var.den_web_image != "" || var.image_digests.den_web != ""))

  bool = { true = "true", false = "false" }

  # Mirrors docs/gcp-cloud-run.md (packaging/cloud-run) and the env the
  # openwork-ee Helm chart puts in its ConfigMap; every container receives the
  # same set, as on Kubernetes and in the openwork-aws-ecs module.
  environment = merge({
    CI                                 = "true"
    NODE_ENV                           = "production"
    OPENWORK_DEV_MODE                  = "0"
    DB_MODE                            = "mysql"
    DEN_ORG_MODE                       = "single_org"
    DEN_SINGLE_ORG_NAME                = var.org_name
    DEN_SINGLE_ORG_SLUG                = var.org_slug
    DEN_SINGLE_ORG_OWNER_EMAILS        = join(",", var.owner_emails)
    DEN_BOOTSTRAP_ADMIN_EMAILS         = join(",", var.owner_emails)
    DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP = local.bool[var.allow_public_signup]
    DEN_REQUIRE_EMAIL_VERIFICATION     = local.bool[var.require_email_verification]
    DEN_BASE_URL                       = local.web_url
    BETTER_AUTH_URL                    = local.web_url
    DEN_API_PUBLIC_URL                 = local.api_url
    DEN_MCP_RESOURCE_URL               = "${local.api_url}/mcp"
    DEN_MCP_CLAIM_NAMESPACE            = local.web_url
    DEN_BETTER_AUTH_TRUSTED_ORIGINS    = local.web_url
    DEN_WEB_APP_HOSTS                  = local.web_host
    DEN_CORS_ORIGINS                   = "${local.web_url},${local.api_url}"
    CORS_ORIGINS                       = "${local.web_url},${local.api_url}"
    DEN_AUTOMATIONS_ENABLED            = local.bool[var.automations_enabled]
    DEN_AUTOMATIONS_RUNTIME_ENABLED    = "false"
    DEN_DASHBOARDS_ENABLED             = local.bool[var.dashboards_enabled]
    PROVISIONER_MODE                   = "stub"
    # Cloud Run has no private service discovery: den-web reaches den-api at
    # its public HTTPS URL (the load balancer host with domain_name).
    DEN_API_BASE                       = local.api_url
    DEN_AUTH_FALLBACK_BASE             = local.api_url
    DEN_AUTH_ORIGIN                    = local.web_url
    DEN_WEB_PUBLIC_ORIGIN              = local.web_url
    DEN_WEB_OPENWORK_AUTH_CALLBACK_URL = local.web_url
    EMAIL_FROM                         = var.email_from
    SMTP_HOST                          = var.smtp.host
    SMTP_PORT                          = tostring(var.smtp.port)
    SMTP_USER                          = var.smtp.username
    SMTP_SECURE                        = local.bool[var.smtp.secure]
  }, var.extra_environment)

  # Cloud Run reserves PORT and sets it from the container port.
  environment_list = { for k, v in local.environment : k => v if v != "" && k != "PORT" }

  # Keys must be known at plan time (they name Secret Manager secrets), so
  # optional ones are selected by whether their input is set.
  secret_keys = toset(concat(
    ["DATABASE_URL", "BETTER_AUTH_SECRET", "DEN_DB_ENCRYPTION_KEY", "DEN_INITIAL_ADMIN_BOOTSTRAP_CODE"],
    nonsensitive(var.smtp.password != "") ? ["SMTP_PASS"] : [],
    nonsensitive(var.resend_api_key != "") ? ["RESEND_API_KEY"] : [],
  ))

  secret_values = {
    DATABASE_URL                     = local.database_url
    BETTER_AUTH_SECRET               = random_password.better_auth.result
    DEN_DB_ENCRYPTION_KEY            = random_password.db_encryption.result
    DEN_INITIAL_ADMIN_BOOTSTRAP_CODE = local.bootstrap_code
    SMTP_PASS                        = var.smtp.password
    RESEND_API_KEY                   = var.resend_api_key
  }

  bootstrap_code = var.initial_admin_bootstrap_code != "" ? var.initial_admin_bootstrap_code : random_password.bootstrap_code.result

  # env var name => { secret, version } for every container.
  secret_refs = merge(
    { for k in local.secret_keys : k => { secret = google_secret_manager_secret.app[k].secret_id, version = google_secret_manager_secret_version.app[k].version } },
    { for k, id in var.extra_secrets : k => { secret = id, version = "latest" } },
  )

  service_account_email = var.service_account_email != "" ? var.service_account_email : google_service_account.run[0].email
}

resource "random_password" "better_auth" {
  length  = 48
  special = false
}

resource "random_password" "db_encryption" {
  length  = 48
  special = false
}

resource "random_password" "bootstrap_code" {
  length  = 24
  special = false
}

# Secret Manager -------------------------------------------------------------

resource "google_secret_manager_secret" "app" {
  for_each = local.secret_keys

  project   = var.project_id
  secret_id = "${var.name}-den-${replace(lower(each.key), "_", "-")}"
  labels    = var.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "app" {
  for_each = local.secret_keys

  secret      = google_secret_manager_secret.app[each.key].id
  secret_data = local.secret_values[each.key]
}

# Runtime identity -----------------------------------------------------------

resource "google_service_account" "run" {
  count = var.service_account_email == "" ? 1 : 0

  project      = var.project_id
  account_id   = "${var.name}-den-run"
  display_name = "OpenWork Den on Cloud Run (${var.name})"
}

resource "google_project_iam_member" "cloudsql_client" {
  count = var.grant_iam_roles ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${local.service_account_email}"
}

resource "google_secret_manager_secret_iam_member" "app" {
  for_each = var.grant_iam_roles ? local.secret_keys : toset([])

  project   = var.project_id
  secret_id = google_secret_manager_secret.app[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.service_account_email}"
}

resource "google_secret_manager_secret_iam_member" "extra" {
  for_each = var.grant_iam_roles ? var.extra_secrets : {}

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.service_account_email}"
}

# Image mirror ---------------------------------------------------------------

# Cloud Run pulls only from Artifact Registry (or Docker Hub); this remote
# repository proxies and caches the public ghcr.io images on first pull.
resource "google_artifact_registry_repository" "ghcr" {
  count = local.mirror_enabled ? 1 : 0

  project       = var.project_id
  location      = var.region
  repository_id = "${var.name}-ghcr"
  description   = "Pull-through cache of ghcr.io for OpenWork images"
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"
  labels        = var.labels

  remote_repository_config {
    description = "ghcr.io"
    docker_repository {
      custom_repository {
        uri = "https://ghcr.io"
      }
    }
  }
}
