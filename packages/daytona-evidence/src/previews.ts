import { randomBytes, randomUUID } from "node:crypto";
import type { BuildProgress, PreviewSession, PreviewWorld, ReviewPreviewProvider } from "@openwork/evidence-provider/review";
import { readAsset } from "@openwork/freestyle/assets";
import { checkoutRecipe, compiledRecipe, dependencyRecipe, toolsRecipe } from "@openwork/freestyle/build-recipes";
import { digest, sourceTree } from "@openwork/freestyle/cache";
import { DaytonaApi, type Sandbox } from "./api.ts";
import { DAYTONA_BASE_SNAPSHOT, ensureBase, ensureLayer, runScript, type DaytonaBuildOptions } from "./builder.ts";

/** These are fresh direct app previews, not saved evidence-browser viewers. */
import { DAYTONA_PREVIEW_WORLDS } from "./credentials.ts";
export { DAYTONA_PREVIEW_WORLDS } from "./credentials.ts";
export { PREVIEW_KIND } from "./kinds.ts";
import { PREVIEW_KIND } from "./kinds.ts";
export const PREVIEW_SNAPSHOT_PREFIX = "ow-dy-review-v1-";
export const PREVIEW_TOOLS_PREFIX = "ow-dy-review-tools-v1-";
const ROOT = "/opt/openwork-preview";
const LIFETIME_SECONDS = 2 * 3600;
const BUILDER_KIND = "openwork-daytona-builder-v1";

function validate(sha: string, world: PreviewWorld) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full pushed source SHA is required");
  if (!DAYTONA_PREVIEW_WORLDS.includes(world)) throw new Error("Daytona fresh previews currently support OpenWork web only");
}

/** Signed per-port hosts, never an unsigned sandbox host or a query-token URL. */
export function previewOrigin(value: string): { origin: string; suffix: string } {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || url.pathname !== "/" || !/^8080-[a-z0-9]+\.daytonaproxy\d{2}\.(?:net|eu)$/.test(url.hostname)) {
    throw new Error("Daytona did not issue a supported signed preview host");
  }
  return { origin: url.origin, suffix: url.hostname.slice(url.hostname.indexOf(".")) };
}

// Keep the shared app runtime; adapt only its provider-specific browser domain.
// A checked replacement fails closed if the shared asset changes shape.
function daytonaRuntime(source: string): string {
  const original = 'browserHostSuffix: ".preview.openwork.software"';
  if (source.split(original).length !== 2) throw new Error("Shared app preview runtime has changed");
  return source.replace(original, "browserHostSuffix: process.env.OPENWORK_DAYTONA_PREVIEW_HOST_SUFFIX")
    .replaceAll('"/opt/openwork-preview/services.json"', '"/opt/openwork-preview/state/services.json"')
    .replaceAll('"/opt/openwork-preview/outputs.json"', '"/opt/openwork-preview/state/outputs.json"');
}

export async function previewDescriptor(sha: string, world: PreviewWorld) {
  validate(sha, world);
  const [runtime, gateway, origins, health] = await Promise.all([
    readAsset("runtime.mjs"), readAsset("gateway.mjs"), readAsset("origins.mjs"), readAsset("health.mjs"),
  ]);
  const scripts = { runtime: daytonaRuntime(runtime), gateway, origins,
    health: health.replaceAll('"/opt/openwork-preview/services.json"', '"/opt/openwork-preview/state/services.json"')
      .replaceAll('"/opt/openwork-preview/outputs.json"', '"/opt/openwork-preview/state/outputs.json"') };
  const tools = toolsRecipe(world);
  const dependencies = dependencyRecipe(world);
  const compile = compiledRecipe(world).replaceAll("/opt/openwork-preview/compiled", "/opt/openwork-preview/state/compiled");
  const controllerHash = digest(JSON.stringify({ version: 2, base: DAYTONA_BASE_SNAPSHOT, scripts, tools, dependencies, compile }));
  return { name: `${PREVIEW_SNAPSHOT_PREFIX}${digest(`${sha}\n${world}\n${controllerHash}`)}`,
    toolsName: `${PREVIEW_TOOLS_PREFIX}${digest(DAYTONA_BASE_SNAPSHOT + tools)}`, controllerHash, scripts, tools, dependencies, compile };
}

export async function hasDaytonaPreview(sha: string, world: PreviewWorld, api = new DaytonaApi()): Promise<boolean> {
  const descriptor = await previewDescriptor(sha, world);
  return (await api.getSnapshot(descriptor.name))?.state === "active";
}

/** Uses the same private layer locks and guest runner as Daytona evidence preparation. */
export async function buildDaytonaPreview(sha: string, world: PreviewWorld, api = new DaytonaApi(), options: DaytonaBuildOptions = {}) {
  const descriptor = await previewDescriptor(sha, world);
  if ((await api.getSnapshot(descriptor.name))?.state === "active") return descriptor;
  // Metadata only on the credentialed host. Public PR code executes solely in its guest.
  await sourceTree(sha, options.sourceFetch);
  const observe = options.observe ?? (() => {});
  await ensureLayer(api, { name: descriptor.name, stage: "review-world", withMemory: true, observe,
    labels: { sourceSha: sha, world, reviewBuild: `${world}-${sha}` },
    parent: () => ensureLayer(api, { name: descriptor.toolsName, stage: "review-tools", withMemory: false, observe,
      parent: () => ensureBase(api, options),
      prepare: (sandbox) => runScript(api, sandbox, "review-tools", descriptor.tools, options),
    }),
    prepare: async (sandbox) => {
      // Daytona rewrites Host. The one port-bound gateway forwards only to app-web;
      // Vite's same-origin engine proxy uses the provider's browser-domain suffix.
      const route = await api.signedPreviewUrl(sandbox.id, 8080, 60);
      const { suffix } = previewOrigin(route);
      for (const [name, source] of Object.entries(descriptor.scripts)) {
        await api.writeFile(sandbox, `${ROOT}/${name}.mjs`, source);
      }
      await api.writeFile(sandbox, "/etc/systemd/system/openwork-review-runtime.service", `[Unit]\nDescription=OpenWork fresh web preview\n[Service]\nType=oneshot\nRemainAfterExit=yes\nUser=openwork-preview\nGroup=openwork-preview\nNoNewPrivileges=yes\nCapabilityBoundingSet=\nProtectSystem=strict\nPrivateTmp=yes\nReadWritePaths=/workspace ${ROOT}/state /home/openwork-preview\nWorkingDirectory=/workspace\nEnvironment=PATH=${ROOT}/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nEnvironment=OPENWORK_DAYTONA_PREVIEW_HOST_SUFFIX=${suffix}\nExecStart=/usr/bin/env node ${ROOT}/runtime.mjs\n`);
      await api.writeFile(sandbox, "/etc/systemd/system/openwork-review-gateway.service", `[Unit]\nDescription=Private OpenWork review gateway\n[Service]\nExecStart=/usr/bin/env node ${ROOT}/gateway.mjs\nRestart=on-failure\n`);
      // The checkout, dependency tools and build all execute report code. None may
      // run as root, even before access is assigned: they could plant a token thief
      // in the hot snapshot. Controller scripts and the gateway stay root-owned.
      await api.writeFile(sandbox, `${ROOT}/review-app.sh`, `#!/bin/bash\nset -euo pipefail\nexport HOME=/home/openwork-preview\nexport pnpm_config_verify_deps_before_run=false\n${checkoutRecipe(sha)}\n${descriptor.dependencies}\n${descriptor.compile}\n`);
      await runScript(api, sandbox, "review-world", `useradd --create-home --shell /usr/sbin/nologin openwork-preview
install -d -o openwork-preview -g openwork-preview /workspace ${ROOT}/state
systemd-run --wait --pipe --collect --unit=openwork-review-app --property=User=openwork-preview --property=Group=openwork-preview --property=NoNewPrivileges=yes --property=CapabilityBoundingSet= /bin/bash ${ROOT}/review-app.sh
systemctl daemon-reload
systemctl start openwork-review-runtime
node ${ROOT}/health.mjs
curl --retry 60 --retry-delay 1 --retry-max-time 120 --retry-all-errors -fsS http://127.0.0.1:5178/ >/dev/null
printf %s ${sha} > ${ROOT}/source-sha
printf %s ${descriptor.controllerHash} > ${ROOT}/review-controller
systemctl start openwork-review-gateway`, options);
    },
  });
  return descriptor;
}

export async function daytonaPreviewProgress(sha: string, world: PreviewWorld, api = new DaytonaApi()): Promise<BuildProgress> {
  const descriptor = await previewDescriptor(sha, world);
  for (const [name, layer] of [[descriptor.name, "running-template"], [descriptor.toolsName, "tools"], [DAYTONA_BASE_SNAPSHOT, "tools"]]) {
    const sandbox = await api.getSandbox(`ow-dy-build-${digest(name).slice(0, 24)}`);
    if (sandbox?.labels.kind === BUILDER_KIND && !["error", "build_failed", "stopped", "archived", "destroyed"].includes(sandbox.state)) {
      return { building: true, layer, since: sandbox.createdAt, steps: [] };
    }
  }
  return { building: false, steps: [] };
}

export class DaytonaPreviewLaunchError extends Error {
  readonly stage: string;
  readonly sandboxId: string;
  constructor(stage: string, sandboxId: string) {
    super("Daytona preview could not be reached");
    this.name = "DaytonaPreviewLaunchError";
    this.stage = stage;
    this.sandboxId = sandboxId;
  }
}

/** A full authorized page and same-origin backend must answer, not just the launch gateway. */
export async function verifyDaytonaPreview(url: string, token: string, probe: typeof fetch = fetch): Promise<void> {
  const headers = { "x-daytona-skip-preview-warning": "true" };
  const launch = await probe(url, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const cookie = launch.headers.get("set-cookie")?.split(";", 1)[0];
  await launch.body?.cancel();
  if (launch.status !== 303 || cookie !== `__Host-openwork-preview=${token}`) throw new Error("Private preview handshake failed");
  const origin = new URL(url).origin;
  for (const path of ["/", "/api/openwork/health"]) {
    const response = await probe(`${origin}${path}`, { headers: { ...headers, cookie }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Fresh preview service is not ready"); }
    if (path === "/") {
      if (!(await response.text()).includes("/@vite/client")) throw new Error("Fresh preview did not serve the app");
    } else {
      if (!response.headers.get("content-type")?.includes("application/json")) { await response.body?.cancel(); throw new Error("Fresh preview backend did not answer"); }
      await response.json();
    }
  }
}

export async function launchDaytonaPreview(input: { gitSha: string; reportId: string; world: PreviewWorld }, api = new DaytonaApi(), probe: typeof fetch = fetch): Promise<PreviewSession> {
  const descriptor = await previewDescriptor(input.gitSha, input.world);
  if (!/^[a-f0-9]{32}$/.test(input.reportId)) throw new Error("Invalid report ID");
  if ((await api.getSnapshot(descriptor.name))?.state !== "active") throw new Error("This commit has no ready Daytona preview");
  const expiresAt = new Date(Date.now() + LIFETIME_SECONDS * 1000).toISOString();
  const created = await api.createSandbox({ name: `ow-dy-review-${randomUUID().replaceAll("-", "")}`, snapshot: descriptor.name,
    labels: { kind: PREVIEW_KIND, sourceSha: input.gitSha, reportId: input.reportId, world: input.world, expiresAt },
    autoStopMinutes: 30, autoDeleteMinutes: 0 });
  let stage = "restore";
  let owned = created.labels.kind === PREVIEW_KIND && created.labels.sourceSha === input.gitSha
    && created.labels.world === input.world && created.labels.reportId === input.reportId && created.labels.expiresAt === expiresAt;
  try {
    if (!owned) throw new Error("Preview creation ownership mismatch");
    if (created.public !== false) throw new Error("Provider did not confirm a private preview");
    const sandbox: Sandbox = await api.waitForSandbox(created.id, ["started"]);
    if (sandbox.id !== created.id || sandbox.labels.kind !== PREVIEW_KIND || sandbox.labels.sourceSha !== input.gitSha
      || sandbox.labels.world !== input.world || sandbox.labels.reportId !== input.reportId || sandbox.labels.expiresAt !== expiresAt) {
      owned = false;
      throw new Error("Preview ownership mismatch");
    }
    if (sandbox.public !== false) throw new Error("Restored preview is not private");
    stage = "verify-source";
    const [source, controller, head] = await Promise.all([
      api.readFile(sandbox, `${ROOT}/source-sha`), api.readFile(sandbox, `${ROOT}/review-controller`),
      api.execChecked(sandbox, "runuser -u openwork-preview -- /bin/bash -c 'cd /workspace && git rev-parse HEAD'", 30),
    ]);
    if (source?.trim() !== input.gitSha || head.trim() !== input.gitSha || controller?.trim() !== descriptor.controllerHash) throw new Error("Preview source mismatch");
    stage = "deadline";
    // This runs in the clone, never the reusable snapshot. The guest shuts down
    // even if the review function dies; provider auto-delete reclaims stopped VMs.
    const remaining = Math.floor((Date.parse(expiresAt) - Date.now()) / 1000);
    if (remaining <= 0) throw new Error("Preview expired during restore");
    await api.execChecked(sandbox, `systemd-run --unit=openwork-review-expiry --on-active=${remaining}s /usr/sbin/poweroff`, 30);
    stage = "assign-access";
    const { origin } = previewOrigin(await api.signedPreviewUrl(sandbox.id, 8080, remaining));
    const token = randomBytes(32).toString("base64url");
    await api.writeFile(sandbox, `${ROOT}/access.json`, JSON.stringify({ sandboxId: sandbox.id, sourceSha: input.gitSha, token, expiresAt, allowedOrigins: [origin] }), 0o600);
    stage = "guest-health";
    await api.execChecked(sandbox, `node ${ROOT}/health.mjs`, 75);
    const url = `${origin}/__openwork_launch?token=${token}`;
    stage = "private-access";
    await verifyDaytonaPreview(url, token, probe);
    if (Date.parse(expiresAt) <= Date.now()) throw new Error("Preview expired during readiness");
    return { id: sandbox.id, gitSha: input.gitSha, world: input.world, url, expiresAt,
      outputs: { webUrl: { value: url, secret: true, group: "Services", note: "Private fresh OpenWork web preview" }, sourceSha: { value: input.gitSha, group: "World" } } };
  } catch {
    if (owned) await api.deleteSandbox(created.id).catch(() => undefined);
    throw new DaytonaPreviewLaunchError(stage, created.id);
  }
}

/** Injectable transport for unit witnesses; production needs only server-side API credentials. */
export function daytonaFreshPreviewMethods(api: () => DaytonaApi = () => new DaytonaApi()): Pick<ReviewPreviewProvider, "hasSnapshot" | "buildSnapshot" | "buildProgress" | "launchPreview" | "launchFailureDetails"> {
  return {
    hasSnapshot: (sha, world) => hasDaytonaPreview(sha, world, api()),
    buildSnapshot: (sha, world) => buildDaytonaPreview(sha, world, api()),
    buildProgress: (sha, world) => daytonaPreviewProgress(sha, world, api()),
    launchPreview: (input) => launchDaytonaPreview(input, api()),
    launchFailureDetails: (error) => error instanceof DaytonaPreviewLaunchError ? {
      stage: error.stage,
      ...(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(error.sandboxId) ? { vmId: error.sandboxId } : {}),
    } : {},
  };
}

