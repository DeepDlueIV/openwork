"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { DenNotice } from "../../_components/ui/notice";
import {
  getAgentPermissionsRoute,
  getEveryoneAgentsRoute,
  getMembersTeamsRoute,
  getTeamAgentsRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EVERYONE_SCOPE, hasTeamRecord, type AgentPermissionPolicy } from "./agent-permissions-data";
import {
  AgentPermissionsAccessState,
  AgentsPanel,
  ReadOnlyNotice,
  WithPolicies,
  changedDefinitions,
  plural,
  useAgentPermissionsAccess,
} from "./agent-permissions-editor";
import { LinkButton } from "./item-list";
import { PermissionAreaSection, PermissionsPage } from "./permissions-ui";

const TITLE = "Agent permissions";

/**
 * Settings › Agent permissions: Everyone and every team with its own changes.
 * Each row opens where it is edited: Members › Teams › Everyone, or the
 * team's Agents tab.
 */
export function AgentPermissionsScreen() {
  const access = useAgentPermissionsAccess();
  if (access.state !== "ready") return <PermissionsPage title={TITLE} testId="agent-permissions-landing"><AgentPermissionsAccessState access={access} /></PermissionsPage>;
  return (
    <PermissionsPage title={TITLE} testId="agent-permissions-landing">
      {!access.canManage ? <ReadOnlyNotice /> : null}
      <WithPolicies orgId={access.orgId}>
        {(data) => {
          const teams = data.teams.filter(hasTeamRecord);
          return (
            <>
              <PermissionAreaSection label="Defaults" testId="agent-permissions-defaults">
                <PolicyRow
                  policy={data.everyone}
                  appliesTo={`Everyone in the organization, ${plural(access.memberCount, "member", "members")}`}
                  summary={changedDefinitions(data.everyone.settings).length === 0 ? "Everything allowed" : plural(changedDefinitions(data.everyone.settings).length, "permission", "permissions") + " set"}
                  href={getEveryoneAgentsRoute(access.orgSlug)}
                />
              </PermissionAreaSection>
              <PermissionAreaSection
                label="Team agent permissions"
                meta={<LinkButton href={getMembersTeamsRoute(access.orgSlug)} variant="secondary" size="sm" data-testid="agent-permissions-open-teams">Open Teams</LinkButton>}
                testId="agent-permissions-teams"
              >
                {teams.length === 0 ? (
                  <div className="flex min-h-12 items-center py-3 text-[13px] text-gray-500" data-testid="agent-permissions-teams-empty">
                    No team agent permissions yet.
                  </div>
                ) : teams.map((policy) => (
                  <PolicyRow
                    key={policy.scopeId}
                    policy={policy}
                    appliesTo={`${policy.name} team, ${plural(policy.memberCount ?? 0, "member", "members")}`}
                    summary={plural(changedDefinitions(policy.settings).length, "override", "overrides")}
                    href={getTeamAgentsRoute(access.orgSlug, policy.scopeId)}
                  />
                ))}
              </PermissionAreaSection>
            </>
          );
        }}
      </WithPolicies>
    </PermissionsPage>
  );
}

function PolicyRow({ policy, appliesTo, summary, href }: { policy: AgentPermissionPolicy; appliesTo: string; summary: string; href: string }) {
  return (
    <Link
      href={href}
      data-testid={`agent-permissions-row-${policy.scopeId}`}
      className="group flex min-h-12 items-center gap-3 py-2 transition-colors hover:bg-gray-50/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium text-gray-900">{policy.name}</span>
        <span className="truncate text-[12px] text-gray-500">{appliesTo}</span>
      </div>
      <span className="shrink-0 text-[12px] text-gray-700">{summary}</span>
      <ChevronRight className="size-4 shrink-0 text-gray-500 transition-colors group-hover:text-gray-700" aria-hidden="true" strokeWidth={1.5} />
    </Link>
  );
}

/** One record, edited with the same panel as Members › Teams. */
export function AgentPermissionsScopeScreen({ scopeId }: { scopeId: string }) {
  const access = useAgentPermissionsAccess();
  const { orgContext } = useOrgDashboard();
  const team = scopeId === EVERYONE_SCOPE ? null : orgContext?.teams.find((entry) => entry.id === scopeId) ?? null;
  const title = scopeId === EVERYONE_SCOPE ? "Everyone" : team?.name ?? TITLE;
  const back = access.state === "ready" ? { href: getAgentPermissionsRoute(access.orgSlug), label: TITLE } : undefined;
  return (
    <PermissionsPage title={title} back={back} testId="agent-permissions-scope">
      {scopeId !== EVERYONE_SCOPE && !team && orgContext ? (
        <DenNotice tone="neutral" message="This team doesn't exist anymore. Go back to Agent permissions to see what's current." />
      ) : (
        <AgentsPanel team={team ? { id: team.id, name: team.name } : null} />
      )}
    </PermissionsPage>
  );
}
