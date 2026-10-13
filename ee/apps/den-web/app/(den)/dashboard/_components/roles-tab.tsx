"use client";

import { LockKeyhole, Plus, ShieldCheck, Users } from "lucide-react";
import { DenNotice } from "../../_components/ui/notice";
import {
  getNewRoleRoute,
  getOrgAccessFlags,
  getPermissionSetRoute,
  getTeamRoute,
  orgFeatureEnabled,
  permissionLockReason,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection, LinkButton } from "./item-list";
import { usePermissionSets } from "./permissions-data";
import { TEAM_ROLE_DESCRIPTIONS } from "./team-roles";

function RoleTile({ team = false }: { team?: boolean }) {
  const Icon = team ? Users : ShieldCheck;
  return (
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-50 text-gray-500">
      <Icon className="h-4 w-4" strokeWidth={1.8} />
    </span>
  );
}

function peopleLabel(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

/**
 * Members › Roles (teamRoles). The built-in roles, and each team's custom
 * role, read from what Den already stores: member roles, Admin teams, and team
 * permission sets. Creating a role makes a team and its permission set.
 */
export function RolesTab() {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  if (!orgContext) return null;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);
  const permissionsFeature = orgFeatureEnabled(orgContext, "permissions");
  return <RolesTabContent orgId={orgId} orgSlug={orgSlug} permissionsFeature={permissionsFeature} canViewSets={permissionsFeature && access.canViewPermissions} canCreate={permissionsFeature && access.canManageTeams && access.canManagePermissions} />;
}

function RolesTabContent({ orgId, orgSlug, permissionsFeature, canViewSets, canCreate }: {
  orgId: string | null;
  orgSlug: string | null;
  permissionsFeature: boolean;
  canViewSets: boolean;
  canCreate: boolean;
}) {
  const { orgContext } = useOrgDashboard();
  const setsQuery = usePermissionSets(orgId, canViewSets);
  if (!orgContext) return null;
  const sets = setsQuery.data ?? [];
  const memberSet = sets.find((set) => set.kind === "member_default");
  const adminSet = sets.find((set) => set.kind === "admin_default");
  const teamSets = sets.filter((set) => set.kind === "team" && set.team);

  const owner = orgContext.members.find((member) => member.isOwner);
  const directAdmins = orgContext.members.filter((member) => !member.isOwner && member.userId !== null && member.role === "admin").length;
  const adminTeams = orgContext.teams.filter((team) => team.grantsOrganizationAdmin);
  const adminWho = [directAdmins > 0 ? peopleLabel(directAdmins) : null, ...adminTeams.map((team) => team.name)].filter(Boolean).join(", ") || "Nobody yet";

  const createAction = canCreate
    ? <LinkButton href={getNewRoleRoute(orgSlug)} size="sm" variant="primary" data-testid="roles-create"><Plus className="h-3.5 w-3.5" aria-hidden />Create role</LinkButton>
    : null;

  return (
    <div className="flex flex-col gap-6" data-testid="roles-tab">
      {createAction ? <div className="flex justify-end">{createAction}</div> : null}
      <ItemSection title="Built-in roles" testId="roles-built-in">
        <ItemPanel>
          <ItemRow
            logo={<RoleTile />}
            title="Member"
            description="What everyone can do"
            status="Everyone"
            href={memberSet ? getPermissionSetRoute(orgSlug, memberSet.id) : undefined}
            testId="role-row-member"
          />
          <ItemRow
            logo={<RoleTile />}
            title="Admin"
            description={TEAM_ROLE_DESCRIPTIONS.admin.replace(", like every admin", "")}
            status={adminWho}
            href={adminSet ? getPermissionSetRoute(orgSlug, adminSet.id) : undefined}
            testId="role-row-admin"
          />
          <ItemRow
            logo={<RoleTile />}
            title="Owner"
            description="Can do everything"
            status={owner ? (owner.user.name || owner.user.email) : undefined}
            testId="role-row-owner"
          />
        </ItemPanel>
      </ItemSection>

      <ItemSection title="Custom roles" testId="roles-custom">
        {!permissionsFeature ? (
          <DenNotice tone="neutral" icon={LockKeyhole} message="Custom roles need Permissions, an Enterprise feature." />
        ) : !canViewSets ? (
          <DenNotice tone="neutral" icon={LockKeyhole} message={permissionLockReason("permissions.view")} />
        ) : setsQuery.isPending ? (
          <ItemPanel><ItemRowsSkeleton label="Loading custom roles" rows={2} /></ItemPanel>
        ) : setsQuery.isError ? (
          <DenNotice tone="error" message={setsQuery.error instanceof Error ? setsQuery.error.message : "Couldn't load custom roles."} />
        ) : teamSets.length === 0 ? (
          <ItemPanel>
            <div className="px-5 py-6 text-[13px] text-gray-500" data-testid="roles-custom-empty">No custom roles yet.</div>
          </ItemPanel>
        ) : (
          <ItemPanel>
            {teamSets.map((set) => {
              const team = orgContext.teams.find((entry) => entry.id === set.team?.id);
              const memberCount = team?.memberIds.length ?? (set.appliesTo.kind === "team" ? set.appliesTo.memberCount : 0);
              return (
                <ItemRow
                  key={set.id}
                  logo={<RoleTile team />}
                  title={team?.name ?? set.team?.name ?? set.name}
                  description={`${set.allowedCount} ${set.allowedCount === 1 ? "permission" : "permissions"}`}
                  status={peopleLabel(memberCount)}
                  href={team ? getTeamRoute(orgSlug, team.id) : getPermissionSetRoute(orgSlug, set.id)}
                  testId="role-row-custom"
                />
              );
            })}
          </ItemPanel>
        )}
      </ItemSection>
    </div>
  );
}
