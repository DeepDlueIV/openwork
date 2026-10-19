"use client";

import { useEffect, useState } from "react";
import { denApiCredentials, denBrowserEndpoint } from "../(den)/_lib/den-api-origin";
import { getRuntimeConfig } from "../(den)/_lib/runtime-config";

/** Presentation only. Den still validates the signed query, consent, PKCE and workspace membership. */
export function isWorkbotSignIn(search: string) {
  const params = new URLSearchParams(search);
  return params.get("client_id") === "openwork-workbot" && params.get("response_type") === "code";
}

export function workbotFirstRunEnabled(payload: unknown) {
  if (typeof payload !== "object" || payload === null || !("features" in payload)) return false;
  const features = payload.features;
  return typeof features === "object" && features !== null && "workbotFirstRun" in features && features.workbotFirstRun === true;
}

/** Before workspace choice use the public rollout; once chosen honor its override. Missing keys fail closed. */
export function useWorkbotFirstRun(search: string, organizationId?: string) {
  const [enabled, setEnabled] = useState(false);
  const workbot = isWorkbotSignIn(search);
  useEffect(() => {
    if (!workbot) return;
    const controller = new AbortController();
    void getRuntimeConfig().then(async () => {
      const endpoint = denBrowserEndpoint(organizationId ? "/v1/org" : "/v1/features");
      const response = await fetch(endpoint, {
        credentials: denApiCredentials(endpoint), cache: "no-store", signal: controller.signal,
        headers: organizationId ? { "x-openwork-org-id": organizationId } : {},
      });
      const payload: unknown = response.ok ? await response.json() : null;
      if (!controller.signal.aborted) setEnabled(workbotFirstRunEnabled(payload));
    }).catch(() => { if (!controller.signal.aborted) setEnabled(false); });
    return () => controller.abort();
  }, [workbot, organizationId]);
  return workbot && enabled;
}
