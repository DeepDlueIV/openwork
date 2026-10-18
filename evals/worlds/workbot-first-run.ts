import { spawn } from "node:child_process";
import { allocateFreePorts } from "@openwork/cdp";
import { denFetch } from "@openwork/behaviors";
import { personDefaults, queryDenDatabase, type Seed } from "@openwork/env";
import { bootWorkbot } from "../../worlds/lib/workbot.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Real Workbot, Den OAuth, verification and runner. All services and provider fixtures are disposable and local. */
export async function workbotFirstRun(seed: Seed) {
  const resources = new AsyncDisposableStack();
  try {
    const [redisPort] = await allocateFreePorts(1);
    if (!redisPort) throw new Error("No local cache port available");
    const redis = spawn("redis-server", ["--bind", "127.0.0.1", "--port", String(redisPort), "--save", "", "--appendonly", "no"], { stdio: ["ignore", "pipe", "pipe"] });
    resources.defer(async () => {
      if (redis.exitCode !== null || redis.signalCode !== null) return;
      await new Promise<void>((resolve) => { redis.once("exit", () => resolve()); redis.kill("SIGTERM"); });
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Disposable cache did not start")), 10_000);
      redis.once("error", error => { clearTimeout(timeout); reject(error); });
      redis.once("exit", code => { clearTimeout(timeout); reject(new Error(`Disposable cache exited: ${code}`)); });
      redis.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("Ready to accept connections")) { clearTimeout(timeout); resolve(); }
      });
    });
    const world = await bootWorkbot(resources, undefined, {
      live: false,
      // Deployment cache keys cannot be shared across other local worlds' disposable MySQL databases.
      denEnv: { DATABASE_REDIS_URL: `redis://127.0.0.1:${redisPort}`, DEN_ORG_MODE: "multi_org", DEN_REQUIRE_EMAIL_VERIFICATION: "true", DEN_FEATURE_WORKBOT_FIRST_RUN: "true" },
    });
    const rollout = await denFetch(world.den.admin, "/v1/admin/features/workbot", {
      method: "PUT", headers: { authorization: `Bearer ${world.den.admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const feature = isRecord(rollout.body) ? rollout.body.feature : null;
    if (!rollout.response.ok || !isRecord(feature) || feature.enabled !== true || feature.killed === true || feature.lock === false) {
      throw new Error(`Local Workbot rollout is not enabled: HTTP ${rollout.response.status}`);
    }
    const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    const person = personDefaults("first-workbot", undefined, runId);
    const web = await seed.web({ den: world.den, headless: true, viewport: { width: 1440, height: 1000 } });
    const database = world.den.database;
    if (!database) throw new Error("Email verification needs the disposable local database");
    return {
      web, person, url: world.workbotUrl, workspaceName: `Example studio ${runId}`,
      async otp() {
        const rows = await queryDenDatabase(database.url, "SELECT value FROM verification WHERE identifier = ? ORDER BY created_at DESC LIMIT 1", [`email-verification-otp-${person.email}`]);
        return isRecord(rows[0]) && typeof rows[0].value === "string" ? rows[0].value.split(":")[0] : "";
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
