import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewerDaytonaAuthorization } from "./features.ts";

const payload = (enabled: boolean) => ({ version: 1, deployment: "cloud", features: { reviewerDaytonaPreviews: enabled } });

function authority(body: unknown) {
  return reviewerDaytonaAuthorization({ fetch: async () => Response.json(body, { headers: { "cache-control": "private, no-store" } }) });
}

test("only an explicit true on a known cloud response authorizes", async () => {
  assert.deepEqual(await authority(payload(true)), { enabled: true });
  for (const body of [payload(false), { version: 1, deployment: "cloud", features: {} }, { ...payload(true), deployment: "self_hosted" }]) {
    const result = await authority(body);
    assert.equal(result.enabled, false);
    assert.ok("reason" in result && result.reason.includes("deployment administrator"));
  }
});

test("cached or old authority responses cannot authorize a launch", async () => {
  for (const cacheControl of ["", "public, max-age=60, stale-if-error=86400"]) {
    assert.equal((await reviewerDaytonaAuthorization({ fetch: async () => Response.json(payload(true), { headers: { "cache-control": cacheControl } }) })).enabled, false);
  }
});

test("malformed and unknown feature responses fail closed", async () => {
  for (const body of [null, [], {}, { ...payload(true), version: 2 }, { ...payload(true), deployment: "unknown" },
    { ...payload(true), features: [] }, { ...payload(true), features: { reviewerDaytonaPreviews: "true" } },
    { ...payload(true), features: { reviewerDaytonaPreviews: true, other: null } }]) {
    assert.equal((await authority(body)).enabled, false);
  }
  assert.equal((await reviewerDaytonaAuthorization({ fetch: async () => new Response("not json") })).enabled, false);
});

test("fresh bounded public requests contain no credentials or browser-controlled headers", async () => {
  let requested = false;
  const result = await reviewerDaytonaAuthorization({
    baseUrl: "https://den.example.test/",
    fetch: async (input, init) => {
      requested = true;
      assert.equal(String(input), "https://den.example.test/v1/features");
      assert.equal(init?.method, "GET");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      assert.deepEqual(init?.headers, { accept: "application/json", "cache-control": "no-cache" });
      assert.ok(init?.signal instanceof AbortSignal);
      return Response.json(payload(true), { headers: { "cache-control": "private, no-store" } });
    },
  });
  assert.ok(requested);
  assert.deepEqual(result, { enabled: true });
});

test("standard service configuration and cloud fallback choose the authority, not request input", async () => {
  const previous = process.env.DEN_API_BASE;
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => { urls.push(String(input)); return Response.json(payload(true), { headers: { "cache-control": "private, no-store" } }); };
  try {
    process.env.DEN_API_BASE = "https://den.local.example.test";
    assert.deepEqual(await reviewerDaytonaAuthorization({ fetch }), { enabled: true });
    delete process.env.DEN_API_BASE;
    assert.deepEqual(await reviewerDaytonaAuthorization({ fetch }), { enabled: true });
    assert.deepEqual(urls, ["https://den.local.example.test/v1/features", "https://api.openworklabs.com/v1/features"]);
  } finally {
    if (previous === undefined) delete process.env.DEN_API_BASE;
    else process.env.DEN_API_BASE = previous;
  }
});

test("invalid or credential-bearing service configuration is never fetched", async () => {
  let requests = 0;
  for (const baseUrl of ["not a url", "http://127.0.0.1:8790", "http://den.example.test", "file:///secret", "https://user:secret@den.example.test", "https://den.example.test/?token=secret", "https://den.example.test/#secret"]) {
    assert.equal((await reviewerDaytonaAuthorization({ baseUrl, fetch: async () => { requests++; return Response.json(payload(true), { headers: { "cache-control": "private, no-store" } }); } })).enabled, false);
  }
  assert.equal(requests, 0);
});

test("non-success, redirects and network errors fail closed without exposing errors", async () => {
  for (const status of [302, 401, 404, 500, 503]) {
    assert.equal((await reviewerDaytonaAuthorization({ fetch: async () => new Response("secret", { status }) })).enabled, false);
  }
  const result = await reviewerDaytonaAuthorization({ fetch: async () => { throw new Error("secret service credential"); } });
  assert.equal(result.enabled, false);
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("timeout aborts the request and fails closed", async () => {
  const result = await reviewerDaytonaAuthorization({
    timeoutMs: 10,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      // AbortSignal.timeout does not keep Node alive on its own.
      const keepAlive = setTimeout(() => reject(new Error("timeout was not propagated")), 1000);
      init?.signal?.addEventListener("abort", () => clearTimeout(keepAlive), { once: true });
    }),
  });
  assert.equal(result.enabled, false);
});

test("each call refreshes: a kill or failed refresh never reuses an earlier authorization", async () => {
  let body = payload(true);
  let unavailable = false;
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => {
    requests++;
    if (unavailable) throw new Error("unavailable");
    return Response.json(body, { headers: { "cache-control": "private, no-store" } });
  };
  assert.deepEqual(await reviewerDaytonaAuthorization({ fetch }), { enabled: true });
  body = payload(false);
  assert.equal((await reviewerDaytonaAuthorization({ fetch })).enabled, false);
  body = payload(true);
  assert.deepEqual(await reviewerDaytonaAuthorization({ fetch }), { enabled: true });
  unavailable = true;
  assert.equal((await reviewerDaytonaAuthorization({ fetch })).enabled, false);
  assert.equal(requests, 4);
});
