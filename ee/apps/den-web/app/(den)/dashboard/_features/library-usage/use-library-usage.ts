"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { getOrgAccessFlags } from "../../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { libraryUsagePath, libraryUsageReportSchema, type LibraryUsageKind, type LibraryUsageWindow } from "./library-usage-data";

/** True when the signed-in member can view usage analytics. */
export function useLibraryUsageAvailable() {
  const { orgContext } = useOrgDashboard();
  const member = orgContext?.currentMember;
  return member ? getOrgAccessFlags(member.role, member.isOwner, member.permissions).canViewUsageAnalytics : false;
}

export function useLibraryUsage(kind: LibraryUsageKind, days: LibraryUsageWindow) {
  const { orgId, orgContext, orgBusy, orgError, mutationBusy } = useOrgDashboard();
  const available = useLibraryUsageAvailable();
  const enabled = Boolean(orgId && orgContext?.organization.id === orgId && available && !orgBusy && !orgError && mutationBusy !== "switch-organization");

  return useQuery({
    queryKey: ["library-usage", orgId, orgContext?.currentMember.id, kind, days],
    enabled,
    queryFn: async ({ signal }) => {
      if (!orgId) throw new Error("Library usage needs a workspace.");
      const { response, payload } = await requestJson(libraryUsagePath(kind, days), { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, signal }, 20_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Could not load usage (${response.status}).`));
      return libraryUsageReportSchema.parse(payload);
    },
    // Keep the last counts while switching range; never show another view's rows.
    placeholderData: (previous) => previous?.kind === kind ? keepPreviousData(previous) : undefined,
    retry: false,
    staleTime: 60_000,
  });
}
