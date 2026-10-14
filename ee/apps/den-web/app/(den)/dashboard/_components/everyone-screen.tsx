"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, ShieldCheck, SquareTerminal } from "lucide-react";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { getMembersTeamsRoute, getOrgAccessFlags, getPermissionSetRoute, orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IconTile } from "./access-rows";
import { AgentsPanel, agentsTabVisible } from "./agent-permissions-editor";
import { ItemPanel, ItemRow } from "./item-list";
import { usePermissionSets } from "./permissions-data";

export type EveryoneTab = "role" | "agents";

/**
 * Members › Teams › Everyone: every member, including people in no team.
 * Its Agents tab is the base every team's Agents tab changes.
 */
export function EveryoneScreen({ initialTab }: { initialTab: EveryoneTab | null }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  const access = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions)
    : null;
  const showAgents = agentsTabVisible(orgContext);
  const [chosenTab, setChosenTab] = useState<EveryoneTab | null>(initialTab);
  const activeTab: EveryoneTab = chosenTab === "agents" && showAgents ? "agents" : "role";
  const memberCount = orgContext?.members.length ?? 0;
  const canViewSets = Boolean(orgContext && orgFeatureEnabled(orgContext, "permissions") && access?.canViewPermissions);
  const setsQuery = usePermissionSets(orgId, canViewSets);
  const memberSet = setsQuery.data?.find((set) => set.kind === "member_default");
  const tabs: readonly TabItem<EveryoneTab>[] = [
    { value: "role", label: "Role", icon: ShieldCheck },
    ...(showAgents ? [{ value: "agents" as const, label: "Agents", icon: SquareTerminal }] : []),
  ];

  return (
    <div className="mx-auto max-w-[860px] px-6 py-8 md:px-8" data-testid="everyone-screen">
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link
          href={getMembersTeamsRoute(orgSlug)}
          className="inline-flex items-center gap-1.5 text-[13px] text-gray-500 transition hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
      </div>

      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-950">Everyone</h1>
        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[12px] font-medium text-gray-600">
          {memberCount} {memberCount === 1 ? "member" : "members"}
        </span>
      </header>

      <UnderlineTabs className="mt-6" tabs={tabs} activeTab={activeTab} onChange={setChosenTab} />

      <div className="mt-6">
        {activeTab === "role" ? (
          <div role="tabpanel" aria-label="Role">
            <ItemPanel>
              <ItemRow
                logo={<IconTile icon={ShieldCheck} />}
                title="Member"
                description="What everyone can do"
                status="Built-in role"
                href={memberSet ? getPermissionSetRoute(orgSlug, memberSet.id) : undefined}
                testId="everyone-role-member"
              />
            </ItemPanel>
          </div>
        ) : (
          <div role="tabpanel" aria-label="Agents">
            <AgentsPanel team={null} />
          </div>
        )}
      </div>
    </div>
  );
}
