"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AdminAccessScreen } from "./admin-access-screen";
import { requestAdmin, withStoredBearer, type AdminResult } from "./admin-request";

// The signed-out path never downloads or mounts the dashboard and its controls.
const DenAdminPanel = lazy(() => import("../den-admin-panel").then((module) => ({ default: module.DenAdminPanel })));

type OverviewState = AdminResult<unknown> | { access: "checking" };

export function AdminOverviewPage({ hasSessionCookie }: { hasSessionCookie: boolean }) {
  const [state, setState] = useState<OverviewState>(() => hasSessionCookie ? { access: "checking" } : { access: "signed-out", message: "" });
  const controllerRef = useRef<AbortController | null>(null);
  const load = useCallback(async (force = false) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const fixture = process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).get("adminScaleFixture") === "1";
    // Drop the legacy persisted snapshot. Never render admin records before a
    // successful access check, including on a shared browser after sign-out.
    try { window.sessionStorage.removeItem("den-admin-overview-cache"); } catch { /* Storage is optional. */ }
    if (!force && !hasSessionCookie && !withStoredBearer({}).Authorization && !fixture) {
      setState({ access: "signed-out", message: "" });
      return;
    }
    setState({ access: "checking" });
    try {
      const result = fixture
        ? { access: "ready", data: (await import("../den-admin-panel")).adminScaleFixturePayload("/v1/admin/overview") } satisfies AdminResult<unknown>
        : await requestAdmin("/v1/admin/overview", (payload) => payload, controller.signal);
      if (!controller.signal.aborted) setState(result);
    } catch (error) {
      if (!controller.signal.aborted) setState({ access: "error", message: error instanceof Error ? error.message : "Could not check admin access." });
    }
  }, [hasSessionCookie]);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  return state.access === "ready"
    ? <Suspense fallback={<AdminAccessScreen state="checking" />}><DenAdminPanel initialPayload={state.data} /></Suspense>
    : <AdminAccessScreen state={state.access} message={"message" in state ? state.message : undefined} onRetry={() => void load(true)} />;
}
