import assert from "node:assert/strict";
import { test } from "node:test";
import { ORG_SCOPE_HEADER, setRequestOrgScope } from "../../app/(den)/_lib/org-scope";
import { adminServicesTransport } from "../admin/services/admin-services-transport";
import { createOrgServicesTransport, ORG_SERVICES_PATH, serviceRetryAfter } from "./org-services-transport";
import { runServicesReadiness, serviceRows } from "./service-readiness-data";

const report = { version: 1, checkedAt: null, checking: false, services: serviceRows(null) };

test("normal adapter pins organization, sends bodyless checks, polls only GET and forwards cancellation", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { path: string; init: RequestInit }[] = [];
  const controller = new AbortController();
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), init: init ?? {} });
    return Response.json({ ...report, checking: calls.length === 1 });
  };
  setRequestOrgScope("another-org");
  try {
    const transport = createOrgServicesTransport("selected-org");
    const result = await runServicesReadiness({
      signal: controller.signal, check: true,
      startCheck: () => transport.startCheck(controller.signal),
      getSnapshot: () => transport.getSnapshot(controller.signal),
      wait: async () => undefined, onSnapshot: () => undefined,
    });
    assert.equal(result.status, "ready");
    assert.equal(calls.length, 2);
    assert.ok(calls[0].path.endsWith(`${ORG_SERVICES_PATH}/check`));
    assert.ok(calls[1].path.endsWith(ORG_SERVICES_PATH));
    assert.deepEqual(calls.map((call) => call.init.method), ["POST", "GET"]);
    for (const call of calls) {
      assert.equal(call.init.body, undefined);
      assert.equal(call.init.signal, controller.signal);
      assert.equal(new Headers(call.init.headers).get(ORG_SCOPE_HEADER), "selected-org");
      assert.ok(!call.path.includes("/admin/"));
    }
    controller.abort();
    await assert.rejects(transport.getSnapshot(controller.signal));
    await assert.rejects(transport.startCheck(controller.signal));
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = originalFetch; setRequestOrgScope(null); }
});

test("normal adapter rejects malformed facts and bounds Retry-After without retaining server diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const transport = createOrgServicesTransport("org");
    const signal = new AbortController().signal;
    globalThis.fetch = async () => Response.json({ message: "https://private.example.test/secret" }, { status: 429, headers: { "Retry-After": "17" } });
    const result = await transport.startCheck(signal);
    assert.equal(result.access, "error");
    assert.equal(result.retryAfterSeconds, 17);
    assert.ok(!JSON.stringify(result).includes("private"));
    for (const value of [null, "-1", "0", "3601", "999999999999999999", "Infinity", "Wed, 21 Oct 2026 07:28:00 GMT", "private upstream failure"]) assert.equal(serviceRetryAfter(value), undefined);
    globalThis.fetch = async () => Response.json({ ...report, url: "https://private.example.test" });
    assert.deepEqual(await transport.getSnapshot(signal), { access: "error", message: "" });
    for (const status of [401, 403, 404]) {
      globalThis.fetch = async () => Response.json({ error: "feature_disabled", message: "raw diagnostic" }, { status });
      const denied = await transport.getSnapshot(signal);
      assert.ok(!JSON.stringify(denied).includes("raw diagnostic"));
      assert.notEqual(denied.access, "ready");
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("cancellation after an in-flight response prevents stale facts from being published", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requests = 0;
  let snapshots = 0;
  globalThis.fetch = async () => {
    requests += 1;
    controller.abort();
    return Response.json({ ...report, checking: true });
  };
  try {
    const transport = createOrgServicesTransport("org");
    await assert.rejects(runServicesReadiness({
      signal: controller.signal, check: true,
      startCheck: () => transport.startCheck(controller.signal),
      getSnapshot: () => transport.getSnapshot(controller.signal),
      wait: async () => undefined, onSnapshot: () => { snapshots += 1; },
    }));
    assert.equal(requests, 1);
    assert.equal(snapshots, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("internal admin adapter preserves its paths and uses the same snapshot contract", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => { paths.push(String(input)); return Response.json(report); };
  try {
    const signal = new AbortController().signal;
    assert.equal((await adminServicesTransport.getSnapshot(signal)).access, "ready");
    assert.equal((await adminServicesTransport.startCheck(signal)).access, "ready");
    assert.ok(paths[0].endsWith("/v1/admin/services"));
    assert.ok(paths[1].endsWith("/v1/admin/services/check"));
  } finally { globalThis.fetch = originalFetch; }
});
