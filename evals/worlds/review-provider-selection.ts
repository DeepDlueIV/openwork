import { createServer } from "node:http";
import { chrome, localHost } from "@openwork/hosts";
import { setViewport } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import { reviewWorld } from "./evidence-review.ts";

/** Real production reviewer; provider effects terminate at local HTTP witnesses. */
async function providerWorld(_seed: Seed, { place }: { place: Place }, credentials: "both" | "daytona" | "neither") {
  if (place.kind !== "local") throw new Error("Reviewer provider UI proof requires isolated local placement.");
  const resources = new AsyncDisposableStack();
  try {
    let enabled = true;
    let unavailable = false;
    const providerCalls: string[] = [];
    const authority = createServer((request, response) => {
      response.setHeader("cache-control", "private, no-store");
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/features") {
        response.writeHead(unavailable ? 503 : 200);
        response.end(JSON.stringify({ version: 1, deployment: "cloud", features: { reviewerDaytonaPreviews: enabled } }));
      } else {
        providerCalls.push(request.url ?? "unknown");
        response.writeHead(503); response.end(JSON.stringify({ message: "Local provider witness refuses provisioning" }));
      }
    });
    await new Promise<void>((resolve, reject) => { authority.once("error", reject); authority.listen(0, "127.0.0.1", resolve); });
    resources.defer(() => new Promise<void>((resolve) => { authority.closeAllConnections(); authority.close(() => resolve()); }));
    const address = authority.address();
    if (!address || typeof address === "string") throw new Error("Missing authority fixture port");
    const authorityUrl = `http://127.0.0.1:${address.port}`;
    const review = resources.use(await reviewWorld("preview", false, false, {
      FREESTYLE_API_KEY: credentials === "both" ? "synthetic-freestyle-fixture" : "",
      DAYTONA_API_KEY: credentials === "neither" ? "" : "synthetic-daytona-fixture",
      OPENWORK_EVIDENCE_PROVIDER: "freestyle", DEN_API_BASE: authorityUrl, DAYTONA_API_URL: authorityUrl,
    }));
    let mode: "success" | "failure" | "real" = "success";
    const requests: { world?: string; provider?: string }[] = [];
    const proxy = createServer(async (request, response) => {
      try {
        if (request.method === "POST" && request.url?.endsWith("/launch") && mode !== "real") {
          let raw = ""; for await (const chunk of request) raw += chunk.toString();
          const body: { world?: string; provider?: string } = JSON.parse(raw);
          requests.push(body);
          const provider = body.provider ?? "freestyle";
          const url = provider === "daytona" ? "https://8080-synthetic.daytonaproxy01.net/__openwork_launch?token=fixture" : `https://ow-${"a".repeat(32)}.preview.openwork.software/__openwork_launch?token=fixture`;
          response.writeHead(mode === "success" ? 201 : 502, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify(mode === "success" ? { provider, world: body.world, gitSha: review.report.gitSha, id: "synthetic-preview", url, expiresAt: new Date(Date.now() + 120_000).toISOString(), outputs: { webUrl: { value: url, group: "Services", secret: true } } } : { error: "Synthetic provider failure" }));
          return;
        }
        const init: RequestInit = { method: request.method, signal: AbortSignal.timeout(15_000) };
        if (request.method === "POST") {
          let raw = ""; for await (const chunk of request) raw += chunk.toString();
          init.body = raw;
          init.headers = { "content-type": "application/json", origin: review.baseUrl };
        }
        const upstream = await fetch(`${review.baseUrl}${request.url}`, init);
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/plain", "cache-control": "no-store" });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { response.writeHead(502); response.end("Local fixture unavailable"); }
    });
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    resources.defer(() => new Promise<void>((resolve) => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Missing proxy fixture port");
    const host = resources.use(localHost());
    const app = resources.use(await chrome({ name: "review-provider-selection", host, startUrl: "about:blank", headless: true }));
    await setViewport(app, { width: 1440, height: 1000, deviceScaleFactor: 1 });
    return {
      app, baseUrl: `http://127.0.0.1:${proxyAddress.port}`, passed: review.passed, requests, providerCalls,
      enable(value: boolean) { enabled = value; }, unavailable(value: boolean) { unavailable = value; },
      respond(value: typeof mode) { mode = value; },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}

export const reviewBothProviders = (seed: Seed, context: { place: Place }) => providerWorld(seed, context, "both");
export const reviewDaytonaOnly = (seed: Seed, context: { place: Place }) => providerWorld(seed, context, "daytona");
export const reviewNoProviders = (seed: Seed, context: { place: Place }) => providerWorld(seed, context, "neither");
