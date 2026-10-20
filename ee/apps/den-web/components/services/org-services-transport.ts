import { requestJson } from "../../app/(den)/_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../app/(den)/_lib/org-scope";
import { parseServicesSnapshot, type ServicesSnapshotResult, type ServicesTransport } from "./service-readiness-data";

export const ORG_SERVICES_PATH = "/v1/org/deployment-services";

export function serviceRetryAfter(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 3_600 ? seconds : undefined;
}

/** Captures the selected organization instead of relying on mutable global scope. */
export function createOrgServicesTransport(orgId: string): ServicesTransport {
  const request = async (check: boolean, signal: AbortSignal): Promise<ServicesSnapshotResult> => {
    signal.throwIfAborted();
    const { response, payload } = await requestJson(check ? `${ORG_SERVICES_PATH}/check` : ORG_SERVICES_PATH, {
      method: check ? "POST" : "GET", signal, headers: { [ORG_SCOPE_HEADER]: orgId },
    });
    signal.throwIfAborted();
    if (!response.ok) {
      // Never forward server diagnostics or URLs into rendering state.
      const code = payload && typeof payload === "object" && "error" in payload && payload.error === "feature_disabled" ? "feature_disabled" : undefined;
      return {
        access: response.status === 401 ? "signed-out" : response.status === 403 ? "forbidden" : "error",
        message: "", status: response.status, code,
        retryAfterSeconds: response.status === 429 ? serviceRetryAfter(response.headers.get("Retry-After")) : undefined,
      };
    }
    const snapshot = parseServicesSnapshot(payload);
    return snapshot ? { access: "ready", data: snapshot } : { access: "error", message: "" };
  };
  return { getSnapshot: (signal) => request(false, signal), startCheck: (signal) => request(true, signal) };
}
