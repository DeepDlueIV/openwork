import assert from "node:assert/strict";
import { test } from "node:test";
import { managedDeploymentSchema } from "@openwork/types/den/managed-deployments";
import { deploymentActionError, deploymentStatus, providerName, readinessMessage, type ProviderReadiness } from "./managed-deployments-state";

function deployment(provider: "aws" | "gcp" = "aws") {
  return managedDeploymentSchema.parse({
    id: "00000000-0000-4000-8000-000000000001", name: "Test deployment", provider,
    target: provider === "aws" ? { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" }
      : { projectId: "openwork-test", projectNumber: "123456789012", region: "us-central1", dnsZoneName: "example-test" },
    domainName: "openwork.example.test", ownerEmail: "admin@example.test", size: "small", updateMode: "approval",
    createdAt: "2026-10-01T00:00:00.000Z", webUrl: "https://openwork.example.test", consoleUrl: "https://console.example.test",
    installedVersion: "0.18.56", availableVersion: "0.18.57", updateAvailable: true,
    health: { state: "operational", reportedAt: "2026-10-01T00:00:00.000Z", version: "0.18.56", checks: [] },
    run: { id: "00000000-0000-4000-8000-000000000002", kind: "update", version: "0.18.57", state: "failed",
      createdAt: "2026-10-01T00:00:00.000Z", lastSeenAt: null, expiresAt: "2026-10-02T00:00:00.000Z", expired: false, events: [] },
  });
}

test("failed updates are not masked by operational health on either cloud", () => {
  for (const provider of ["aws", "gcp"] satisfies ("aws" | "gcp")[]) {
    const item = deployment(provider);
    assert.deepEqual(deploymentStatus(item), { label: "Update failed", tone: "danger" });
    if (!item.run) throw new Error("Missing fixture run");
    item.run.expired = true;
    assert.deepEqual(deploymentStatus(item), { label: "Update stopped reporting", tone: "danger" });
  }
});

test("pending approval names the cloud, not the last known health", () => {
  const item = deployment("gcp");
  if (!item.run) throw new Error("Missing fixture run");
  item.run.state = "awaiting_approval";
  assert.equal(deploymentStatus(item).label, "Awaiting Google Cloud approval");
  item.installedVersion = null;
  assert.equal(deploymentStatus(item).label, "Awaiting Google Cloud approval");
  item.run = null;
  assert.equal(deploymentStatus(item).label, "Not launched");
});

test("completed runs return to health even after their approval expires", () => {
  const item = deployment();
  if (!item.run) throw new Error("Missing fixture run");
  item.run.state = "ready";
  item.run.expired = true;
  assert.deepEqual(deploymentStatus(item), { label: "Operational", tone: "neutral" });
});

test("locks name the remediation owner and distinguish readiness causes", () => {
  const reasons: NonNullable<ProviderReadiness["reason"]>[] = ["not_configured", "invalid_configuration", "feature_disabled", "not_supported"];
  const messages = reasons.map((reason) => readinessMessage({ provider: "gcp", available: false, reason, missingFields: ["DEN_MANAGED_DEPLOYMENT_GCP_VERSION"] }));
  assert.equal(new Set(messages).size, reasons.length);
  for (const message of messages) {
    assert.match(message, /Google Cloud/);
    assert.match(message, /OpenWork operator/);
    assert.doesNotMatch(message, /DEN_MANAGED/);
  }
  assert.match(readinessMessage({ provider: "aws", available: false }), /publish and configure a verified installer/);
  assert.equal(providerName("azure"), "Azure");
});

test("late rollout and publication errors give the same operator recovery as readiness", () => {
  assert.equal(deploymentActionError({ error: "feature_disabled" }, "gcp"), readinessMessage({ provider: "gcp", available: false, reason: "feature_disabled" }));
  assert.equal(deploymentActionError({ error: "release_not_configured" }, "gcp"), readinessMessage({ provider: "gcp", available: false, reason: "not_configured" }));
  assert.equal(deploymentActionError({ error: "release_not_configured", message: "An OpenWork operator must correct the published release configuration." }, "gcp"), "An OpenWork operator must correct the published release configuration.");
  assert.equal(deploymentActionError({ error: "fresh_auth_required" }, "gcp"), null);
  assert.equal(deploymentActionError(null, "gcp"), null);
});

test("approval and services started never stand in for verified health", () => {
  const item = deployment("gcp");
  if (!item.run) throw new Error("Missing fixture run");
  item.installedVersion = null;
  item.run.state = "provisioning";
  assert.equal(deploymentStatus(item).label, "Approved · installing");
  item.run.events.push({ sequence: 5, step: "services_ready", outcome: "succeeded", receivedAt: "2026-10-01T00:01:00.000Z" });
  assert.equal(deploymentStatus(item).label, "Services started · checking health");
  item.run.state = "ready";
  item.health.state = "awaiting_report";
  assert.equal(deploymentStatus(item).label, "Waiting for first report");
  item.health.state = "operational";
  assert.equal(deploymentStatus(item).label, "Operational");
});
