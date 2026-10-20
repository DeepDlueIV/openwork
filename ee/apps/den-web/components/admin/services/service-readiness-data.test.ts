import assert from "node:assert/strict";
import { test } from "node:test";
import {
  serviceIdSchema, serviceReadinessReasonSchema, SERVICE_REASON_LABELS, SERVICE_STATE_LABELS,
  type DeploymentServiceReadiness,
} from "@openwork/types/den/service-readiness";
import {
  CHECK_MAX_POLLS, finishServicesRun, parseServicesEnabled, parseServicesSnapshot, runServicesReadiness,
  serviceRows, serviceStateLabel, servicesFailure, SERVICES_VERIFY_ERROR,
} from "./service-readiness-data";

const checkedAt = "2026-10-01T12:00:00.000Z";
function snapshot(checking = false): DeploymentServiceReadiness {
  return {
    version: 1, checkedAt, checking,
    services: serviceRows(null).map((service) => ({ ...service, configured: true, state: "ready", reason: "health_verified", checkedAt, lastSuccessAt: checkedAt })),
  };
}

test("strict shared snapshots reject unknown fields, raw errors, invalid setting names and duplicate services", () => {
  const report = snapshot();
  assert.deepEqual(parseServicesSnapshot(report), report);
  assert.equal(parseServicesSnapshot({ ...report, host: "https://private.example.test" }), null);
  assert.equal(parseServicesSnapshot({ ...report, services: [{ ...report.services[0], error: "raw provider failure" }] }), null);
  assert.equal(parseServicesSnapshot({ ...report, services: [{ ...report.services[0], reason: "provider_error" }] }), null);
  assert.equal(parseServicesSnapshot({ ...report, services: [{ ...report.services[0], missingSettings: ["https://private.example.test"] }] }), null);
  assert.equal(parseServicesSnapshot({ ...report, services: [report.services[0], report.services[0]] }), null);
});

test("all seven initial service slots are unknown and never optimistic green", () => {
  const rows = serviceRows(null);
  assert.deepEqual(rows.map((row) => row.id), serviceIdSchema.options);
  assert.ok(rows.every((row) => row.state === "unknown" && row.reason === "not_checked" && serviceStateLabel(row) === SERVICE_STATE_LABELS.unknown));
  assert.deepEqual(rows.filter((row) => row.required).map((row) => row.id), ["database"]);
  assert.equal(serviceRows({ version: 1, checkedAt: null, checking: true, services: [] }).length, 7);
});

test("state and reason copy is fixed, with stale and unverified states never promoted to Ready", () => {
  for (const reason of serviceReadinessReasonSchema.options) assert.equal(typeof SERVICE_REASON_LABELS[reason], "string");
  assert.match(SERVICE_REASON_LABELS.health_verified, /does not test a model completion or message delivery/);
  assert.match(SERVICE_REASON_LABELS.delivery_unverified, /No message was sent/);
  const row = snapshot().services[0];
  assert.equal(serviceStateLabel(row), "Ready");
  assert.match(serviceStateLabel({ ...row, stale: true }), /Couldn't verify.*stale/);
  assert.equal(serviceStateLabel({ ...row, checkedAt: null }), "Couldn't verify");
  assert.equal(serviceStateLabel({ ...row, reason: "configuration_only" }), "Couldn't verify");
  assert.equal(serviceStateLabel({ ...row, lastSuccessAt: null }), "Couldn't verify");
  for (const reason of serviceReadinessReasonSchema.options) {
    if (reason !== "health_verified" && reason !== "database_verified") assert.equal(serviceStateLabel({ ...row, reason }), "Couldn't verify");
  }
});

test("deployment rollout uses availability, kill switch and operator lock, never an organization override", () => {
  const feature = { key: "serviceReadiness", available: true, killed: false, enabled: false, lock: null };
  const enabled = (changes: Partial<typeof feature> & { lock?: boolean | null }) => parseServicesEnabled({ features: [{ ...feature, ...changes }] });
  assert.equal(enabled({}), false);
  assert.equal(enabled({ enabled: true }), true);
  assert.equal(parseServicesEnabled({ features: [{ ...feature, enabled: false, lock: true }] }), true);
  assert.equal(parseServicesEnabled({ features: [{ ...feature, enabled: true, lock: false }] }), false);
  assert.equal(parseServicesEnabled({ features: [{ ...feature, killed: true, lock: true }] }), false);
  assert.equal(enabled({ available: false, enabled: true }), false);
  assert.equal(parseServicesEnabled({ features: [] }), false);
  assert.equal(parseServicesEnabled({ features: [{ key: "serviceReadiness" }] }), null);
});

test("auth and feature loss clear details, network and cooldown failures keep the last snapshot without provider text", () => {
  const last = snapshot();
  for (const result of [servicesFailure(401), servicesFailure(403), servicesFailure(404, "feature_disabled")]) {
    assert.equal(finishServicesRun(last, result).snapshot, null);
  }
  for (const result of [servicesFailure(500, "secret provider error"), servicesFailure(429)]) {
    assert.equal(finishServicesRun(last, result).snapshot, last);
    assert.doesNotMatch(result.message, /secret provider error/);
  }
  assert.equal(servicesFailure(403).status, "forbidden");
  assert.equal(servicesFailure(404, "feature_disabled").status, "locked");
  assert.equal(servicesFailure(500).message, SERVICES_VERIFY_ERROR);
});

test("an accepted check publishes cached snapshots until complete, without additional POSTs", async () => {
  let starts = 0;
  let gets = 0;
  const seen: boolean[] = [];
  const result = await runServicesReadiness({
    signal: new AbortController().signal, check: true,
    startCheck: async () => { starts += 1; return { access: "ready", data: snapshot(true) }; },
    getSnapshot: async () => { gets += 1; return { access: "ready", data: snapshot(gets < 2) }; },
    wait: async () => undefined,
    onSnapshot: (value) => seen.push(value.checking),
  });
  assert.deepEqual(result, { status: "ready" });
  assert.equal(starts, 1);
  assert.equal(gets, 2);
  assert.deepEqual(seen, [true, true, false]);
});

test("polling is bounded even if a server never finishes", async () => {
  let gets = 0;
  const result = await runServicesReadiness({
    signal: new AbortController().signal, check: false,
    getSnapshot: async () => { gets += 1; return { access: "ready", data: snapshot(true) }; },
    startCheck: async () => { throw new Error("GET refresh must never start probes"); },
    wait: async () => undefined, onSnapshot: () => undefined,
  });
  assert.equal(gets, CHECK_MAX_POLLS + 1);
  assert.equal(result.status, "error");
});

test("abort during a wait and authentication loss both stop subsequent browser requests", async () => {
  const controller = new AbortController();
  let gets = 0;
  await assert.rejects(runServicesReadiness({
    signal: controller.signal, check: true,
    startCheck: async () => ({ access: "ready", data: snapshot(true) }),
    getSnapshot: async () => { gets += 1; return { access: "ready", data: snapshot() }; },
    wait: async () => controller.abort(), onSnapshot: () => undefined,
  }));
  assert.equal(gets, 0);
  for (const status of [401, 403]) {
    const result = await runServicesReadiness({
      signal: new AbortController().signal, check: true,
      startCheck: async () => ({ access: "error", status, message: "untrusted response" }),
      getSnapshot: async () => { gets += 1; return { access: "ready", data: snapshot() }; },
      wait: async () => { throw new Error("No polling after access loss"); }, onSnapshot: () => undefined,
    });
    assert.equal(result.status, status === 401 ? "signed-out" : "forbidden");
    assert.equal(gets, 0);
  }
});
