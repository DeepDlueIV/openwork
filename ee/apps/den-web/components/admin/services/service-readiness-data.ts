import { servicesFailure as sharedServicesFailure, type ServicesFailure } from "../../services/service-readiness-data";

export * from "../../services/service-readiness-data";

export function servicesFailure(status?: number, code?: string): ServicesFailure {
  if (status === 401) return { status: "signed-out", message: "Sign in with an OpenWork admin account to continue." };
  if (status === 403) return { status: "forbidden", message: "This account is not on the OpenWork admin allowlist." };
  if (status === 404 && code === "feature_disabled") return { status: "locked", message: SERVICES_LOCK_REASON };
  return sharedServicesFailure(status, code);
}

export const SERVICES_PATH = "/v1/admin/services";
export const SERVICES_LOCK_REASON = "Service checks are off for this deployment. A platform administrator can enable Service readiness in Feature rollouts.";

/** Internal admin feature report; normal settings use the organization capability. */
export function parseServicesEnabled(payload: unknown): boolean | null {
  if (!payload || typeof payload !== "object" || !("features" in payload) || !Array.isArray(payload.features)) return null;
  const feature: unknown = payload.features.find((entry: unknown) => Boolean(entry && typeof entry === "object" && "key" in entry && entry.key === "serviceReadiness"));
  if (!feature) return false;
  if (typeof feature !== "object" || !("available" in feature) || !("killed" in feature) || !("lock" in feature) || !("enabled" in feature)) return null;
  if (typeof feature.available !== "boolean" || typeof feature.killed !== "boolean" || typeof feature.enabled !== "boolean" || (feature.lock !== null && typeof feature.lock !== "boolean")) return null;
  return feature.available && !feature.killed && (feature.lock ?? feature.enabled);
}
