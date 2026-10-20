import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeploymentCapabilities, type DeploymentCapabilities } from "@openwork/types/den/deployment-capabilities";
import type { OrganizationServiceReadiness, ServiceId } from "@openwork/types/den/service-readiness";
import { formatServiceTime, workbotDeploymentNotice } from "./service-readiness";

const checkedAt = "2026-10-01T12:00:00.000Z";
function projectedService(id: ServiceId): OrganizationServiceReadiness["services"][number] {
  return { id, configured: true, state: "ready", reason: "health_verified", dependencies: [], checkedAt, lastSuccessAt: checkedAt, stale: false };
}
function capabilities(services = [projectedService("headlessRunner"), projectedService("workbot")]): DeploymentCapabilities {
  return { version: 1, aiGateway: true, serviceReadiness: { version: 1, checkedAt, checking: false, services } };
}

test("version-1 projection is optional and malformed or overprivileged projection fails closed", () => {
  assert.deepEqual(parseDeploymentCapabilities({ version: 1, aiGateway: true }), { version: 1, aiGateway: true });
  const input = capabilities();
  assert.deepEqual(parseDeploymentCapabilities(input), input);
  assert.equal(parseDeploymentCapabilities({ ...input, serviceReadiness: { ...input.serviceReadiness, services: [{ ...projectedService("workbot"), missingSettings: ["DEN_WORKBOT_URL"] }] } }).serviceReadiness, undefined);
});

test("off or missing projection leaves the current Workbot settings surface exactly unchanged", () => {
  const unavailable = capabilities([{ ...projectedService("workbot"), configured: false, state: "not_configured", reason: "not_configured" }]);
  assert.equal(workbotDeploymentNotice(unavailable, false), null);
  assert.equal(workbotDeploymentNotice({ version: 1, aiGateway: true }, true), null);
  assert.equal(workbotDeploymentNotice(undefined, true), null);
  assert.equal(workbotDeploymentNotice(capabilities(), true), null);
});

test("missing Workbot web service does not revoke models used by Slack or Automations", () => {
  const notice = workbotDeploymentNotice(capabilities([{ ...projectedService("workbot"), configured: false, state: "not_configured", reason: "not_configured" }]), true);
  assert.match(notice?.message ?? "", /deployment administrator/);
  assert.match(notice?.message ?? "", /Model settings for Slack and Automations are still available/);
  assert.doesNotMatch(JSON.stringify(notice), /disabled|DEN_WORKBOT|https:/);
});

test("runner setup and transient failures have recovery copy, timestamps and no authorization semantics", () => {
  const missing = workbotDeploymentNotice(capabilities([{ ...projectedService("headlessRunner"), configured: false, state: "not_configured" }]), true);
  assert.match(missing?.message ?? "", /Headless runner isn't set up/);
  for (const state of ["unreachable", "unknown"] satisfies OrganizationServiceReadiness["services"][number]["state"][]) {
    const notice = workbotDeploymentNotice(capabilities([{ ...projectedService("headlessRunner"), state, reason: "request_failed", stale: true }]), true);
    assert.match(notice?.message ?? "", /Couldn't verify/);
    assert.match(notice?.message ?? "", /Existing conversations and model settings are kept/);
    assert.equal(notice?.lastSuccessAt, checkedAt);
    assert.equal(notice?.checkedAt, checkedAt);
    assert.equal(notice?.stale, true);
  }
  const stale = workbotDeploymentNotice(capabilities([{ ...projectedService("workbot"), stale: true }]), true);
  assert.match(stale?.message ?? "", /Couldn't verify Workbot/);
});

test("timestamps are explicit UTC and never fabricate a successful check", () => {
  assert.equal(formatServiceTime(null), "Not yet");
  assert.equal(formatServiceTime("invalid"), "Not yet");
  assert.match(formatServiceTime(checkedAt), /Oct 1.*12:00 PM UTC/);
});
