import {
  deploymentServiceReadinessSchema,
  serviceIdSchema,
  SERVICE_STATE_LABELS,
  type DeploymentServiceReadiness,
  type DeploymentServiceStatus,
} from "@openwork/types/den/service-readiness";
import type { AdminResult } from "../admin-request";

export const SERVICES_PATH = "/v1/admin/services";
export const CHECK_COOLDOWN_MS = 30_000;
export const CHECK_POLL_MS = 2_000;
export const CHECK_MAX_POLLS = 15;
export const SERVICES_LOCK_REASON = "Service checks are off for this deployment. A platform administrator can enable Service readiness in Feature rollouts.";
export const SERVICES_VERIFY_ERROR = "Couldn't verify services. The last known results are kept. Try Check now again shortly.";

export function parseServicesSnapshot(payload: unknown): DeploymentServiceReadiness | null {
  const parsed = deploymentServiceReadinessSchema.safeParse(payload);
  if (!parsed.success || new Set(parsed.data.services.map((service) => service.id)).size !== parsed.data.services.length) return null;
  return parsed.data;
}

/** Missing rows are explicitly unknown, including the first snapshot from a new server. */
export function serviceRows(snapshot: DeploymentServiceReadiness | null): DeploymentServiceStatus[] {
  return serviceIdSchema.options.map((id) => snapshot?.services.find((service) => service.id === id) ?? {
    id, required: id === "database", configured: false, state: "unknown", reason: "not_checked",
    missingSettings: [], dependencies: [], checkedAt: null, lastSuccessAt: null, stale: false,
  });
}

export function serviceStateLabel(service: DeploymentServiceStatus): string {
  if (service.stale) return `${SERVICE_STATE_LABELS.unknown} · stale`;
  // Neither a missing first check nor configuration alone is a verified service.
  if (service.state === "ready" && (!service.checkedAt || !service.lastSuccessAt || !["health_verified", "database_verified"].includes(service.reason))) return SERVICE_STATE_LABELS.unknown;
  return SERVICE_STATE_LABELS[service.state];
}

/** The allowlisted feature report is read before the services endpoint is ever requested. */
export function parseServicesEnabled(payload: unknown): boolean | null {
  if (!payload || typeof payload !== "object" || !("features" in payload) || !Array.isArray(payload.features)) return null;
  const feature: unknown = payload.features.find((entry: unknown) => Boolean(entry && typeof entry === "object" && "key" in entry && entry.key === "serviceReadiness"));
  if (!feature) return false; // Older deployments do not have this feature.
  if (typeof feature !== "object" || !("available" in feature) || !("killed" in feature) || !("lock" in feature) || !("enabled" in feature)) return null;
  if (typeof feature.available !== "boolean" || typeof feature.killed !== "boolean" || typeof feature.enabled !== "boolean" || (feature.lock !== null && typeof feature.lock !== "boolean")) return null;
  return feature.available && !feature.killed && (feature.lock ?? feature.enabled);
}

export type ServicesFailure = { status: "signed-out" | "forbidden" | "locked" | "error"; message: string };
export function servicesFailure(status?: number, code?: string): ServicesFailure {
  if (status === 401) return { status: "signed-out", message: "Sign in with an OpenWork admin account to continue." };
  if (status === 403) return { status: "forbidden", message: "This account is not on the OpenWork admin allowlist." };
  if (status === 404 && code === "feature_disabled") return { status: "locked", message: SERVICES_LOCK_REASON };
  if (status === 429) return { status: "error", message: "Service checks are cooling down. Wait a moment, then choose Check now." };
  return { status: "error", message: SERVICES_VERIFY_ERROR };
}

export type ServicesRunResult = { status: "ready" } | ServicesFailure;
export type ServicesViewState = {
  status: "checking" | ServicesRunResult["status"];
  snapshot: DeploymentServiceReadiness | null;
  pending: boolean;
  message?: string;
};

export function finishServicesRun(snapshot: DeploymentServiceReadiness | null, result: ServicesRunResult): ServicesViewState {
  return {
    status: result.status, pending: false,
    snapshot: result.status === "signed-out" || result.status === "forbidden" || result.status === "locked" ? null : snapshot,
    message: result.status === "ready" ? undefined : result.message,
  };
}

type SnapshotResult = AdminResult<DeploymentServiceReadiness>;

/** Poll cached server facts only, with an abort boundary before every request. */
export async function runServicesReadiness(options: {
  signal: AbortSignal;
  check: boolean;
  getSnapshot: () => Promise<SnapshotResult>;
  startCheck: () => Promise<SnapshotResult>;
  wait: () => Promise<void>;
  onSnapshot: (snapshot: DeploymentServiceReadiness) => void;
}): Promise<ServicesRunResult> {
  const { signal } = options;
  signal.throwIfAborted();
  let result = await (options.check ? options.startCheck() : options.getSnapshot());
  for (let polls = 0; ; polls += 1) {
    signal.throwIfAborted();
    if (result.access !== "ready") {
      return servicesFailure(result.access === "signed-out" ? 401 : result.access === "forbidden" ? 403 : result.status, result.code);
    }
    options.onSnapshot(result.data);
    if (!result.data.checking) return { status: "ready" };
    if (polls >= CHECK_MAX_POLLS) return { status: "error", message: "The service check is still running. Choose Check now shortly to read its latest result." };
    await options.wait();
    signal.throwIfAborted();
    result = await options.getSnapshot();
  }
}

export function waitForServicePoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, CHECK_POLL_MS);
    signal.addEventListener("abort", abort, { once: true });
  });
}
