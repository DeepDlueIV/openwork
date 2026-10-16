import { useCallback, useEffect, useRef, useState } from "react";
import { isLoopbackOpenworkServerUrl } from "@/app/lib/openwork-server";
import { checkOnlineConnection, isLocalNetworkEndpoint, useOfflineRecoveryStore } from "./offline-recovery-store";

const networkKinds = new Set(["network-unavailable", "provider-unreachable", "provider-connection-dropped", "provider-timeout"]);
export function isConnectivityError(kind: string | undefined) { return kind !== undefined && networkKinds.has(kind); }

type StopState = "stopping" | "stopped" | "unconfirmed";

/** Only a local engine's retry boundary is stopped. A tool already executing
 * may have written externally; a remote task may still be running normally. */
export function useSessionOfflineRecovery(options: {
  owner: string;
  engineUrl: string;
  onlineModel: boolean;
  retrying: boolean;
  idle: boolean;
  networkFailure: boolean;
  stopRetry: () => Promise<boolean>;
}) {
  const { owner, engineUrl, onlineModel, retrying, networkFailure, idle } = options;
  const enabled = useOfflineRecoveryStore((state) => state.enabled);
  const issue = useOfflineRecoveryStore((state) => state.issue);
  const checking = useOfflineRecoveryStore((state) => state.checking);
  const [hold, setHold] = useState<string | null>(null);
  const [stop, setStop] = useState<{ owner: string; state: StopState } | null>(null);
  const stopRetry = useRef(options.stopRetry);
  stopRetry.current = options.stopRetry;
  const attempted = useRef<{ owner: string } | null>(null);
  const release = useCallback(() => { setHold(null); setStop(null); attempted.current = null; }, []);

  useEffect(() => { release(); }, [owner, enabled, release]);

  useEffect(() => {
    if (enabled && networkFailure) void checkOnlineConnection(true);
  }, [enabled, networkFailure]);

  useEffect(() => {
    if (!enabled || !issue) return;
    if (onlineModel || !isLocalNetworkEndpoint(engineUrl)) setHold(owner);
    if (!onlineModel || !retrying || !isLoopbackOpenworkServerUrl(engineUrl) || attempted.current?.owner === owner) return;
    const attempt = { owner };
    attempted.current = attempt;
    setStop({ owner, state: "stopping" });
    void stopRetry.current().then(
      (stopped) => { if (attempted.current === attempt) setStop({ owner, state: stopped ? "stopped" : "unconfirmed" }); },
      () => { if (attempted.current === attempt) setStop({ owner, state: "unconfirmed" }); },
    );
  }, [enabled, issue, owner, onlineModel, retrying, engineUrl]);

  useEffect(() => {
    if (idle && stop?.owner === owner && stop.state === "unconfirmed") setStop(null);
  }, [idle, stop, owner]);

  return {
    enabled,
    issue: enabled ? issue : null,
    checking,
    held: enabled && hold === owner,
    stop: enabled && stop?.owner === owner ? stop.state : null,
    release,
  };
}
