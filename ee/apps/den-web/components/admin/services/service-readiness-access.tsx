"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { requestAdmin, withStoredBearer } from "../admin-request";
import { parseServicesEnabled, SERVICES_LOCK_REASON, servicesFailure } from "./service-readiness-data";

type ServicesAccess = {
  status: "checking" | "ready" | "locked" | "signed-out" | "forbidden" | "error";
  message?: string;
};
const ServicesAccessContext = createContext<{ access: ServicesAccess; refresh: () => void }>({ access: { status: "checking" }, refresh: () => undefined });
export const useServicesAccess = () => useContext(ServicesAccessContext);

export function ServicesAccessProvider({ hasSessionCookie, children }: { hasSessionCookie: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const [access, setAccess] = useState<ServicesAccess>({ status: "checking" });
  const [checkedPath, setCheckedPath] = useState(pathname);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setCheckedPath(pathname);
    if (!hasSessionCookie && !withStoredBearer({}).Authorization) {
      setAccess({ status: "signed-out" });
      return () => controller.abort();
    }
    setAccess({ status: "checking" });
    requestAdmin("/v1/admin/features", parseServicesEnabled, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.access === "ready") setAccess(result.data ? { status: "ready" } : { status: "locked", message: SERVICES_LOCK_REASON });
      else setAccess(servicesFailure(result.access === "signed-out" ? 401 : result.access === "forbidden" ? 403 : result.status, result.code));
    }).catch(() => {
      if (!controller.signal.aborted) setAccess({ status: "error", message: "Couldn't verify access to service checks. Retry to check your access." });
    });
    return () => controller.abort();
  }, [hasSessionCookie, nonce, pathname]);
  return <ServicesAccessContext.Provider value={{ access: checkedPath === pathname ? access : { status: "checking" }, refresh }}>{children}</ServicesAccessContext.Provider>;
}
