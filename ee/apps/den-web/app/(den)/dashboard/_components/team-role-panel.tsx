"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Check, LockKeyhole, ShieldCheck } from "lucide-react";
import { getPermissionDefinition, permissionDefaultKeys, type PermissionKey } from "@openwork/types/den/permissions";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { getOrgAccessFlags, getPermissionSetRoute, orgFeatureEnabled, type DenOrgTeam } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useDenToast } from "./den-toast";
import { ItemPanel, ItemRowsSkeleton, ItemSection, LinkButton } from "./item-list";
import { useApplyTeamRole, usePermissionSet, usePermissionSets } from "./permissions-data";
import {
  EVERYONE_CAN,
  TEAM_ROLE_DESCRIPTIONS,
  TEAM_ROLE_LABELS,
  allowedKeys,
  teamRole,
  teamRoleLockReason,
  teamRoleSteps,
  type TeamRole,
  type TeamRoleState,
} from "./team-roles";

const ROLE_ORDER: readonly TeamRole[] = ["member", "admin", "custom"];
/** Long lists (Admin allows dozens of permissions) start short; the rest is one click away (DESIGN.md P3). */
const ALSO_PREVIEW = 6;

/** A team's one role, what it adds, and what everyone can do, with one Change role action. */
export function TeamRolePanel({ team }: { team: DenOrgTeam }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  const permissionsFeature = orgContext ? orgFeatureEnabled(orgContext, "permissions") : false;
  const access = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions)
    : null;
  const setsQuery = usePermissionSets(orgId, permissionsFeature);
  const sets = setsQuery.data ?? [];
  const teamSet = sets.find((set) => set.kind === "team" && set.team?.id === team.id) ?? null;
  const adminSet = sets.find((set) => set.kind === "admin_default") ?? null;
  const memberSet = sets.find((set) => set.kind === "member_default") ?? null;
  const state: TeamRoleState = { admin: team.grantsOrganizationAdmin, customSetId: teamSet?.id ?? null };
  const role = teamRole(state);
  const [showAll, setShowAll] = useState(false);

  const teamSetDetail = usePermissionSet(orgId, teamSet?.id ?? "", Boolean(teamSet));
  const adminSetDetail = usePermissionSet(orgId, adminSet?.id ?? "", role === "admin" && Boolean(adminSet));
  const memberSetDetail = usePermissionSet(orgId, memberSet?.id ?? "", Boolean(memberSet && memberSet.allowedCount > 0));

  // With Permissions off, Admin and Member follow the shipped defaults.
  const adminKeys: PermissionKey[] = adminSetDetail.data ? allowedKeys(adminSetDetail.data.permissions) : permissionDefaultKeys("admin");
  const memberKeys: PermissionKey[] = memberSetDetail.data ? allowedKeys(memberSetDetail.data.permissions) : permissionDefaultKeys("member");
  const customKeys: PermissionKey[] = teamSetDetail.data ? allowedKeys(teamSetDetail.data.permissions) : [];
  const alsoKeys = [...new Set([...(role === "admin" ? adminKeys : []), ...customKeys])].filter((key) => !memberKeys.includes(key));

  const loading = permissionsFeature && (setsQuery.isPending || (teamSet !== null && teamSetDetail.isPending));
  const description = role === "admin"
    ? `Everyone in ${team.name} is an admin`
    : role === "custom"
      ? `${customKeys.length} ${customKeys.length === 1 ? "permission" : "permissions"} chosen for ${team.name}`
      : TEAM_ROLE_DESCRIPTIONS.member;

  return (
    <div className="flex flex-col gap-6" data-testid="team-role" data-role={role}>
      {setsQuery.isError ? <DenNotice tone="error" message={setsQuery.error instanceof Error ? setsQuery.error.message : "Couldn't load this team's role."} /> : null}
      <ItemPanel>
        <div className="flex items-center gap-3.5 px-5 py-4">
          <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-50 text-gray-500">
            <ShieldCheck className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[14px] font-medium leading-5 text-gray-900" data-testid="team-role-name">{TEAM_ROLE_LABELS[role]}</span>
            <span className="text-[13px] leading-[18px] text-gray-500">{loading ? "Loading…" : description}</span>
          </span>
          <span className="flex shrink-0 gap-2">
            {teamSet ? <LinkButton size="sm" variant="secondary" href={getPermissionSetRoute(orgSlug, teamSet.id)} data-testid="team-role-edit">Edit permissions</LinkButton> : null}
            <ChangeRoleDialog
              team={team}
              state={state}
              adminKeys={adminKeys}
              abilities={{
                canManageAdminTeams: access?.canManageAdminTeams ?? false,
                canManagePermissions: access?.canManagePermissions ?? false,
                permissionsFeature,
              }}
            />
          </span>
        </div>
      </ItemPanel>

      {loading ? (
        <ItemPanel><ItemRowsSkeleton label="Loading what this team can do" rows={3} /></ItemPanel>
      ) : alsoKeys.length > 0 ? (
        <ItemSection title={`${team.name} can also`} testId="team-role-also">
          <ItemPanel>
            {(showAll ? alsoKeys : alsoKeys.slice(0, ALSO_PREVIEW)).map((key) => <CapabilityRow key={key} label={getPermissionDefinition(key).label} strong />)}
            {alsoKeys.length > ALSO_PREVIEW ? (
              <div className="px-5 py-2.5">
                <DenButton variant="ghost" size="xs" onClick={() => setShowAll(!showAll)} aria-expanded={showAll} data-testid="team-role-show-all">
                  {showAll ? "Show fewer" : `Show all ${alsoKeys.length}`}
                </DenButton>
              </div>
            ) : null}
          </ItemPanel>
        </ItemSection>
      ) : null}

      <ItemSection title="Everyone can" testId="team-role-everyone">
        <ItemPanel>
          {EVERYONE_CAN.map((label) => <CapabilityRow key={label} label={label} />)}
          {memberKeys.map((key) => <CapabilityRow key={key} label={getPermissionDefinition(key).label} />)}
        </ItemPanel>
      </ItemSection>
    </div>
  );
}

function CapabilityRow({ label, strong = false }: { label: string; strong?: boolean }) {
  return (
    <div className="flex items-center gap-3.5 px-5 py-3" data-testid="team-role-capability">
      <span aria-hidden className="flex w-8 shrink-0 justify-center text-gray-900"><Check className="h-4 w-4" strokeWidth={2} /></span>
      <span className={`min-w-0 flex-1 text-[14px] leading-5 ${strong ? "font-medium text-gray-900" : "text-gray-700"}`}>{label}</span>
    </div>
  );
}

function ChangeRoleDialog({ team, state, adminKeys, abilities }: {
  team: DenOrgTeam;
  state: TeamRoleState;
  adminKeys: readonly PermissionKey[];
  abilities: Parameters<typeof teamRoleLockReason>[2];
}) {
  const router = useRouter();
  const toast = useDenToast();
  const { orgId, orgSlug, reauthDialogOpen } = useOrgDashboard();
  const apply = useApplyTeamRole(orgId ?? "", team.id);
  const current = teamRole(state);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<TeamRole>(current);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const lock = (role: TeamRole) => (role === current ? null : teamRoleLockReason(state, role, abilities));
  const everyLocked = ROLE_ORDER.every((role) => role === current || lock(role) !== null);

  async function save() {
    if (choice === current || lock(choice)) return;
    try {
      const createdSetId = await apply.mutateAsync(teamRoleSteps(state, choice, adminKeys));
      setOpen(false);
      toast({ title: `${team.name} is now ${TEAM_ROLE_LABELS[choice]}` });
      if (choice === "custom" && createdSetId) router.push(getPermissionSetRoute(orgSlug, createdSetId));
    } catch {
      return;
    }
  }

  return (
    <Dialog.Root
      open={open && !reauthDialogOpen}
      onOpenChange={(next) => {
        if (apply.isPending) return;
        setOpen(next);
        if (next) {
          setChoice(current);
          apply.reset();
        }
      }}
    >
      <Dialog.Trigger className={buttonVariants({ variant: "secondary", size: "sm" })} data-testid="team-role-change">Change role</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
        <Dialog.Popup
          initialFocus={cancelRef}
          aria-busy={apply.isPending}
          data-testid="team-role-dialog"
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-gray-200 bg-white p-5 outline-none"
        >
          <Dialog.Title className="text-[15px] font-medium text-gray-950">Change the role for {team.name}</Dialog.Title>
          <div role="radiogroup" aria-label={`Role for ${team.name}`} className="mt-4 flex flex-col divide-y divide-gray-100 rounded-xl border border-gray-200">
            {ROLE_ORDER.map((role) => {
              const reason = lock(role);
              const selected = choice === role;
              return (
                <button
                  key={role}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={reason !== null}
                  disabled={reason !== null || apply.isPending}
                  onClick={() => setChoice(role)}
                  data-testid={`team-role-option-${role}`}
                  className="flex items-start gap-3 px-3.5 py-3 text-left outline-none first:rounded-t-xl last:rounded-b-xl focus-visible:bg-gray-50 disabled:cursor-not-allowed"
                >
                  <span aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 rounded-full ${selected ? "border-[5px] border-gray-900" : "border-[1.5px] border-gray-300"} bg-white`} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={`text-[14px] font-medium ${reason ? "text-gray-500" : "text-gray-900"}`}>
                      {TEAM_ROLE_LABELS[role]}{role === current ? <span className="font-normal text-gray-500"> (now)</span> : null}
                    </span>
                    <span className="text-[13px] leading-[18px] text-gray-500">{reason ?? TEAM_ROLE_DESCRIPTIONS[role]}</span>
                  </span>
                  {reason ? <LockKeyhole aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" strokeWidth={1.5} /> : null}
                </button>
              );
            })}
          </div>
          {everyLocked ? <p className="mt-3 text-[12px] text-gray-500">You can't change this team's role.</p> : null}
          {apply.error ? <DenNotice className="mt-4" tone="error" message={apply.error.message} /> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close ref={cancelRef} disabled={apply.isPending} className={buttonVariants({ variant: "secondary", size: "sm" })}>Cancel</Dialog.Close>
            <DenButton
              size="sm"
              disabled={choice === current || lock(choice) !== null}
              loading={apply.isPending}
              onClick={() => void save()}
              data-testid="team-role-save"
            >
              {choice === current ? "Change role" : `Change to ${TEAM_ROLE_LABELS[choice]}`}
            </DenButton>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
