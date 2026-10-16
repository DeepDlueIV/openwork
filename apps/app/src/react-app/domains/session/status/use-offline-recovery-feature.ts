import { useEffect, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { createDenClient, readDenSettings, resolveDenBaseUrls } from "@/app/lib/den"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"

import { checkOnlineConnection, configureOfflineRecovery } from "./offline-recovery-store";

const FEATURE_STALE_MS = 5 * 60_000

/**
 * Whether `offlineRecovery` is on for the current deployment or organization. Signed in, it follows the active organization (`GET /v1/org`
 * features); signed out, the deployment switch (`GET /v1/features`).
 * Missing flags default off; cached flag data survives a temporary outage.
 */
export function useOfflineRecoveryFeature(): void {
  const denAuth = useDenAuth()
  const context = useAutomationsDenContext()
  const baseUrl = readDenSettings().baseUrl
  const deploymentClient = useMemo(() => createDenClient({ baseUrl }), [baseUrl])
  const organization = useQuery({
    // Shares the cache with the other organization feature reads.
    queryKey: ["den", "org-features", context.organizationId],
    queryFn: (): Promise<Record<string, boolean>> => context.client && context.organizationId
      ? context.client.getOrgFeatures(context.organizationId)
      : Promise.resolve({}),
    enabled: context.ready,
    staleTime: FEATURE_STALE_MS,
    select: (features) => features.offlineRecovery === true,
  })
  const deployment = useQuery({
    queryKey: ["den", "deployment-features", baseUrl],
    queryFn: () => deploymentClient.getDeploymentFeatures(),
    enabled: !context.ready && denAuth.status === "signed_out",
    staleTime: FEATURE_STALE_MS,
    retry: false,
    select: (features) => features.offlineRecovery === true,
  })
  const on = context.ready ? organization.data === true : denAuth.status === "signed_out" && deployment.data === true
  const endpoint = `${resolveDenBaseUrls(readDenSettings()).apiBaseUrl.replace(/\/+$/, "")}/v1/features`;
  useEffect(() => {
    configureOfflineRecovery(on, endpoint);
    if (!on) return;
    const check = () => { void checkOnlineConnection(); };
    const visible = () => { if (document.visibilityState === "visible") check(); };
    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    document.addEventListener("visibilitychange", visible);
    if (navigator.onLine === false) check();
    return () => {
      configureOfflineRecovery(false, "");
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [on, endpoint]);
}
