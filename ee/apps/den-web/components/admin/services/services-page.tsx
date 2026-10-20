"use client";

import { ServicesView } from "../../services/services-view";
import { useServicesReadiness } from "../../services/use-services-readiness";
import { adminServicesTransport } from "./admin-services-transport";
import { ServicesAccessScreen } from "./services-access-screen";
import { useServicesAccess } from "./service-readiness-access";

export function ServicesPage() {
  const { access, refresh: refreshAccess } = useServicesAccess();
  const readiness = useServicesReadiness(access.status === "ready", adminServicesTransport);
  if (access.status !== "ready") return <ServicesAccessScreen status={access.status} message={access.message} onRetry={refreshAccess} />;
  const { state } = readiness;
  if (state.status === "locked" || state.status === "signed-out" || state.status === "forbidden") return <ServicesAccessScreen status={state.status} onRetry={refreshAccess} />;
  return <ServicesView {...readiness} testId="admin-services-page" />;
}
