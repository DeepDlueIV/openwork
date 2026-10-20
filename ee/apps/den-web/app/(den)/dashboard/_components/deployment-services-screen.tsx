"use client";

import { useMemo } from "react";
import { LockKeyhole } from "lucide-react";
import { ServicesView } from "../../../../components/services/services-view";
import { useServicesReadiness } from "../../../../components/services/use-services-readiness";
import { createOrgServicesTransport } from "../../../../components/services/org-services-transport";
import { DenNotice } from "../../_components/ui/notice";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export function DeploymentServicesScreen() {
  const { orgContext } = useOrgDashboard();
  const orgId = orgContext?.organization.id ?? "";
  const enabled = orgContext?.canManageDeploymentServices === true;
  // A new organization gets a fresh component and no previous installation facts.
  return <DeploymentServicesContent key={orgId} orgId={orgId} enabled={enabled} />;
}

function DeploymentServicesContent({ orgId, enabled }: { orgId: string; enabled: boolean }) {
  const transport = useMemo(() => createOrgServicesTransport(orgId), [orgId]);
  const readiness = useServicesReadiness(enabled && Boolean(orgId), transport);
  const { state } = readiness;
  if (!enabled || state.status === "forbidden" || state.status === "locked" || state.status === "signed-out") {
    return <section data-testid="services-access-locked" className="grid max-w-4xl gap-4">
      <h1 className="text-lg font-semibold text-[var(--dls-text-primary)]">Services</h1>
      <DenNotice tone="neutral" icon={LockKeyhole} message={state.status === "signed-out" ? "Sign in again to check deployment services." : "Service checks require access from your installation operator."} />
    </section>;
  }
  return <ServicesView {...readiness} />;
}
