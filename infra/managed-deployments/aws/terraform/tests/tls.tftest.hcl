# Exercise the managed platform directly without adding outputs to its interface.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/ecs/test" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:cluster/openwork-den" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/openwork/abc" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/openwork/abc" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/openwork/abc/def" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/openwork" }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openwork" }
  }
  mock_resource "aws_service_discovery_private_dns_namespace" {
    defaults = { arn = "arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-abc" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/openwork:1" }
  }
}
mock_provider "random" {}
mock_provider "http" {
  mock_data "http" {
    defaults = { status_code = 200, response_body = "-----BEGIN CERTIFICATE-----test" }
  }
}

variables {
  openwork_version    = "0.18.58"
  vpc_id              = "vpc-test"
  alb_subnet_ids      = ["subnet-a", "subnet-b"]
  service_subnet_ids  = ["subnet-a", "subnet-b"]
  database_subnet_ids = ["subnet-a", "subnet-b"]
  owner_emails        = ["admin@example.com"]
  domain_name         = "openwork.example.com"
  certificate_arn     = "arn:aws:acm:us-east-1:123456789012:certificate/test"
}

run "strict_default_and_all_db_clients_trust_rds" {
  command = apply
  module { source = "./modules/openwork-aws-ecs" }
  assert {
    condition     = var.database.tls_query == "sslaccept=strict"
    error_message = "Managed RDS must verify its certificate by default."
  }
  assert {
    condition     = data.http.rds_ca.url == "https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem" && data.http.rds_ca.insecure == false
    error_message = "Fetch the regional public RDS bundle over verified HTTPS."
  }
  assert {
    condition = alltrue([for container in concat(
      jsondecode(aws_ecs_task_definition.api.container_definitions),
      jsondecode(aws_ecs_task_definition.web.container_definitions)
      ) : container.entryPoint == ["/bin/sh", "-ec"] && startswith(container.command[0], local.tls_setup) &&
      strcontains(container.command[0], "export NODE_EXTRA_CA_CERTS=/tmp/openwork-db-ca.pem; exec ") &&
      strcontains(container.command[0], base64encode("-----BEGIN CERTIFICATE-----test"))
    ])
    error_message = "Migration, API and web must write the CA and export trust before starting Node."
  }
  assert {
    condition = (
      length(jsondecode(aws_ecs_task_definition.api.container_definitions)) == 2 &&
      jsondecode(aws_ecs_task_definition.api.container_definitions)[0].name == "migrate" &&
      jsondecode(aws_ecs_task_definition.api.container_definitions)[1].dependsOn == [{ containerName = "migrate", condition = "SUCCESS" }]
    )
    error_message = "This exception must not adopt the direct module's migration lifecycle."
  }
}

run "reject_accept" {
  command = plan
  module { source = "./modules/openwork-aws-ecs" }
  variables { database = { tls_query = "sslaccept=accept" } }
  expect_failures = [var.database]
}

run "reject_conflicting_query" {
  command = plan
  module { source = "./modules/openwork-aws-ecs" }
  variables { database = { tls_query = "sslaccept=strict&sslaccept=accept" } }
  expect_failures = [var.database]
}

run "reject_failed_ca_fetch" {
  command = plan
  module { source = "./modules/openwork-aws-ecs" }
  override_data {
    target = data.http.rds_ca
    values = { status_code = 503, response_body = "-----BEGIN CERTIFICATE-----test" }
  }
  expect_failures = [data.http.rds_ca]
}

run "reject_non_pem_ca" {
  command = plan
  module { source = "./modules/openwork-aws-ecs" }
  override_data {
    target = data.http.rds_ca
    values = { status_code = 200, response_body = "not a certificate" }
  }
  expect_failures = [data.http.rds_ca]
}
