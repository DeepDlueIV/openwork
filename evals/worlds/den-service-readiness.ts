import { createServer } from "node:http";
import { once } from "node:events";
import type { Seed } from "@openwork/env";

const TOKEN = "readiness-fixture-service-token-not-production";

/** Only service health is mocked. Den authentication, routes, snapshots and UI are real. */
export async function healthFixture() {
  let calls = 0;
  let unauthorized = 0;
  let unexpected = 0;
  const server = createServer((request, response) => {
    calls++;
    if (request.method !== "GET" || !["/health", "/ready", "/v1/health", "/internal/readiness"].includes(request.url ?? "")) unexpected++;
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    if (request.url === "/health") return void response.end(JSON.stringify({ ok: true, service: "gateway" }));
    if (request.url === "/ready") return void response.end(JSON.stringify({ ok: true, service: "gateway", checks: { database: "ok" } }));
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      unauthorized++;
      response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.url === "/v1/health") return void response.end(JSON.stringify({ version: 1, service: "headless-runner", modelConfigured: true, resumeConfigured: false, denOriginMatches: null }));
    if (request.url === "/internal/readiness") return void response.end(JSON.stringify({ version: 1, service: "workbot", runnerConfigured: true, denOriginMatches: Boolean(request.headers["x-openwork-den-origin"]) }));
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing readiness fixture port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls: () => calls,
    unauthorized: () => unauthorized,
    unexpected: () => unexpected,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export function denServicesWithoutInfrastructure(seed: Seed) { return readinessWorld(seed, false); }
export function denServicesWithInfrastructure(seed: Seed) { return readinessWorld(seed, true); }

async function readinessWorld(seed: Seed, configured: boolean) {
  const stack = new AsyncDisposableStack();
  try {
    const fixture = stack.use(await healthFixture());
    const den = await seed.den({
      org: { name: "Service checks", admin: { name: "Deployment Administrator" }, members: { member: { name: "Workspace Member" } } },
      env: {
        DEN_DEPLOYMENT: "self_hosted", DEN_FEATURE_SERVICE_READINESS: "true",
        GATEWAY_ENABLED: configured ? "true" : "false",
        GATEWAY_PROXY_BASE_URL: configured ? fixture.url : "",
        GATEWAY_PUBLIC_BASE_URL: configured ? fixture.url : "",
        DEN_HEADLESS_RUNNER_URL: configured ? fixture.url : "",
        DEN_HEADLESS_RUNNER_TOKEN: configured ? TOKEN : "",
        DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "", DEN_WORKBOT_URL: configured ? fixture.url : "",
        SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", SMTP_PORT: "", SMTP_SECURE: "", RESEND_API_KEY: "", EMAIL_FROM: "",
      },
    });
    const viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
    const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/services", headless: true, viewport });
    const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/admin/services", headless: true, viewport });
    const anonymous = await seed.web({ den, startPath: "/admin/services", headless: true, viewport });
    return { den, admin, member, anonymous, fixtureCalls: fixture.calls, unauthorizedFixtureCalls: fixture.unauthorized, unexpectedFixtureCalls: fixture.unexpected, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
