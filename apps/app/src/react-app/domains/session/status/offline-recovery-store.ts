import { create } from "zustand";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { desktopFetch } from "@/app/lib/desktop";

export type ConnectivityIssue = "offline" | "unreachable" | null;

type ConnectivityState = {
  enabled: boolean;
  endpoint: string;
  issue: ConnectivityIssue;
  checking: boolean;
};

export const useOfflineRecoveryStore = create<ConnectivityState>(() => ({
  enabled: false, endpoint: "", issue: null, checking: false,
}));

let revision = 0;
let pending: { promise: Promise<ConnectivityIssue>; transportFailed: boolean } | undefined;

export function configureOfflineRecovery(enabled: boolean, endpoint: string) {
  const previous = useOfflineRecoveryStore.getState();
  if (previous.enabled === enabled && previous.endpoint === endpoint) return;
  revision++;
  pending = undefined;
  useOfflineRecoveryStore.setState({ enabled, endpoint, issue: null, checking: false });
}

/** A failed request is corroborated by a separate, read-only service check.
 * An HTTP response (including 401/500) proves connectivity, not service health.
 * Never use the OS hint alone to block a local model or a reachable service. */
export function checkOnlineConnection(transportFailed = false): Promise<ConnectivityIssue> {
  const state = useOfflineRecoveryStore.getState();
  if (!state.enabled || !state.endpoint) return Promise.resolve(null);
  if (pending) {
    pending.transportFailed ||= transportFailed;
    return pending.promise;
  }
  const version = revision;
  const evidence = { transportFailed };
  useOfflineRecoveryStore.setState({ checking: true });
  const check = (async () => {
    let issue: ConnectivityIssue = null;
    try {
      const response = await (isDesktopRuntime() ? desktopFetch : globalThis.fetch)(state.endpoint, {
        method: "GET", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(4_000),
      });
      void response.body?.cancel().catch(() => undefined);
    } catch {
      issue = typeof navigator !== "undefined" && navigator.onLine === false ? "offline"
        : evidence.transportFailed || state.issue ? "unreachable" : null;
    }
    if (version === revision) useOfflineRecoveryStore.setState({ issue, checking: false });
    return version === revision ? issue : null;
  })();
  pending = Object.assign(evidence, { promise: check });
  void check.finally(() => { if (pending?.promise === check) pending = undefined; });
  return check;
}

export function onlineRequestsPaused() {
  const state = useOfflineRecoveryStore.getState();
  return state.enabled && state.issue !== null;
}

/** Loopback and LAN endpoints remain usable without an internet connection. */
export function isLocalNetworkEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const { hostname } = new URL(value);
    return /^(?:localhost|0\.0\.0\.0|\[::1\]|127(?:\.\d+){3}|10(?:\.\d+){3}|192\.168(?:\.\d+){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2})$/.test(hostname)
      || /^\[(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(hostname)
      || hostname.endsWith(".localhost") || hostname.endsWith(".local");
  } catch { return false; }
}
