"use client";

import { Popover } from "@base-ui/react/popover";
import Link from "next/link";
import { useState } from "react";
import { Check, ChevronDown, LockKeyhole, Plus, Search, ShieldCheck } from "lucide-react";
import { getPermissionDefinition, permissionDefaultKeys, type PermissionKey } from "@openwork/types/den/permissions";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { getNewRoleRoute, getOrgAccessFlags, getPermissionSetRoute, type DenOrgTeam } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IconTile } from "./access-rows";
import { useDenToast } from "./den-toast";
import { ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection, LinkButton } from "./item-list";
import { usePermissionSet, usePermissionSets, useSetTeamRole, type PermissionSetSummary } from "./permissions-data";
import {
  TEAM_ROLE_DESCRIPTIONS,
  TEAM_ROLE_LABELS,
  allowedKeys,
  sameSharedTeamRole,
  sharedTeamRole,
  sharedTeamRoleLockReason,
  sharedTeamRoleSteps,
  type SharedTeamRole,
  type SharedTeamRoleState,
  type TeamRoleAbilities,
} from "./team-roles";

/** Teams a set applies to (older responses only carry `team`). */
function setTeams(set: PermissionSetSummary): { id: string; name: string | null }[] {
  return set.teams.length > 0 ? set.teams : set.team ? [set.team] : [];
}

function teamNames(teams: readonly { name: string | null }[]): string {
  return teams.map((team) => team.name ?? "A deleted team").join(", ");
}

/**
 * sharedRoles: a team's one role (Member, Admin, or one of the organization's
 * custom roles), what it adds, and Change role as a searchable picker of every
 * role. A custom role can be on several teams; changing it here only changes
 * this team.
 */
export function SharedTeamRolePanel({ team }: { team: DenOrgTeam }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  const access = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions)
    : null;
  const setsQuery = usePermissionSets(orgId, true);
  const sets = setsQuery.data ?? [];
  const customSets = sets.filter((set) => set.kind === "team");
  const teamSet = customSets.find((set) => setTeams(set).some((entry) => entry.id === team.id)) ?? null;
  const adminSet = sets.find((set) => set.kind === "admin_default") ?? null;
  const memberSet = sets.find((set) => set.kind === "member_default") ?? null;
  const state: SharedTeamRoleState = { admin: team.grantsOrganizationAdmin, setId: teamSet?.id ?? null };
  const role = sharedTeamRole(state);

  const teamSetDetail = usePermissionSet(orgId, teamSet?.id ?? "", Boolean(teamSet));
  const adminSetDetail = usePermissionSet(orgId, adminSet?.id ?? "", Boolean(adminSet));
  const memberSetDetail = usePermissionSet(orgId, memberSet?.id ?? "", Boolean(memberSet && memberSet.allowedCount > 0));
  const adminKeys: PermissionKey[] = adminSetDetail.data ? allowedKeys(adminSetDetail.data.permissions) : permissionDefaultKeys("admin");
  const memberKeys: PermissionKey[] = memberSetDetail.data ? allowedKeys(memberSetDetail.data.permissions) : permissionDefaultKeys("member");
  const customKeys: PermissionKey[] = teamSetDetail.data ? allowedKeys(teamSetDetail.data.permissions) : [];
  const alsoKeys = (role.kind === "admin" ? adminKeys : role.kind === "custom" ? customKeys : []).filter((key) => !memberKeys.includes(key));
  const loading = setsQuery.isPending || (teamSet !== null && teamSetDetail.isPending);

  const otherTeams = teamSet ? setTeams(teamSet).filter((entry) => entry.id !== team.id) : [];
  const title = role.kind === "custom" && teamSet ? teamSet.name : TEAM_ROLE_LABELS[role.kind];
  const description = role.kind === "admin"
    ? `Everyone in ${team.name} is an admin`
    : role.kind === "custom"
      ? otherTeams.length > 0 ? `Custom role, also on ${teamNames(otherTeams)}` : "Custom role"
      : TEAM_ROLE_DESCRIPTIONS.member;
  const abilities: TeamRoleAbilities = {
    canManageAdminTeams: access?.canManageAdminTeams ?? false,
    canManagePermissions: access?.canManagePermissions ?? false,
    permissionsFeature: true,
  };

  return (
    <div className="flex flex-col gap-6" data-testid="team-role" data-role={role.kind}>
      {setsQuery.isError ? <DenNotice tone="error" message={setsQuery.error instanceof Error ? setsQuery.error.message : "Couldn't load this team's role."} /> : null}
      <ItemPanel>
        <div className="flex items-center gap-3.5 px-5 py-4">
          <IconTile icon={ShieldCheck} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[14px] font-medium leading-5 text-gray-900" data-testid="team-role-name">{loading ? <DenSkeleton className="h-5 w-28" /> : title}</span>
            {loading ? <DenSkeleton className="h-[18px] w-48" /> : <span className="text-[13px] leading-[18px] text-gray-500">{description}</span>}
          </span>
          <span className="flex shrink-0 gap-2">
            {teamSet && role.kind === "custom" ? (
              <LinkButton size="sm" variant="secondary" href={getPermissionSetRoute(orgSlug, teamSet.id)} data-testid="team-role-open">Open role</LinkButton>
            ) : null}
            <RolePicker
              team={team}
              state={state}
              customSets={customSets}
              abilities={abilities}
              disabled={loading}
              newRoleHref={getNewRoleRoute(orgSlug)}
            />
          </span>
        </div>
      </ItemPanel>

      {loading ? (
        <ItemPanel><ItemRowsSkeleton label="Loading what this team can do" rows={3} /></ItemPanel>
      ) : alsoKeys.length > 0 ? (
        <ItemSection title={`${team.name} can also`} testId="team-role-also">
          <ItemPanel>
            {alsoKeys.map((key) => <ItemRow key={key} logo={<CheckMark />} title={getPermissionDefinition(key).label} />)}
          </ItemPanel>
        </ItemSection>
      ) : null}
    </div>
  );
}

function CheckMark() {
  return <span aria-hidden className="flex h-8 w-8 items-center justify-center text-gray-900"><Check className="h-4 w-4" strokeWidth={2} /></span>;
}

type PickerOption = { role: SharedTeamRole; title: string; description: string };

/** Change role: every role in one searchable list, opened under the button. */
function RolePicker({ team, state, customSets, abilities, disabled, newRoleHref }: {
  team: DenOrgTeam;
  state: SharedTeamRoleState;
  customSets: PermissionSetSummary[];
  abilities: TeamRoleAbilities;
  disabled: boolean;
  newRoleHref: string;
}) {
  const toast = useDenToast();
  const { orgId, updateTeam } = useOrgDashboard();
  const setTeamRole = useSetTeamRole(orgId ?? "");
  const current = sharedTeamRole(state);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<SharedTeamRole>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const builtIn: PickerOption[] = [
    { role: { kind: "member" }, title: TEAM_ROLE_LABELS.member, description: TEAM_ROLE_DESCRIPTIONS.member },
    { role: { kind: "admin" }, title: TEAM_ROLE_LABELS.admin, description: "Invite people, manage teams, and run connections and models" },
  ];
  const custom: PickerOption[] = customSets.map((set) => {
    const others = setTeams(set).filter((entry) => entry.id !== team.id);
    const onThisTeam = setTeams(set).some((entry) => entry.id === team.id);
    return {
      role: { kind: "custom", setId: set.id },
      title: set.name,
      description: others.length === 0 ? (onThisTeam ? "Only on this team" : "No teams yet") : `${onThisTeam ? "Also on" : "On"} ${teamNames(others)}`,
    };
  });
  const needle = query.trim().toLowerCase();
  const matches = (option: PickerOption) => !needle || `${option.title} ${option.description}`.toLowerCase().includes(needle);
  const visibleBuiltIn = builtIn.filter(matches);
  const visibleCustom = custom.filter(matches);
  const changed = !sameSharedTeamRole(choice, current);
  const chosenTitle = [...builtIn, ...custom].find((option) => sameSharedTeamRole(option.role, choice))?.title ?? "";

  function close() {
    setOpen(false);
    setQuery("");
    setChoice(current);
    setError(null);
  }

  async function run(from: SharedTeamRoleState, to: SharedTeamRole) {
    for (const step of sharedTeamRoleSteps(from, to)) {
      if (step.kind === "set-admin") await updateTeam(team.id, { grantsOrganizationAdmin: step.value });
      else await setTeamRole.mutateAsync({ teamId: team.id, permissionSetId: step.setId });
    }
  }

  async function save() {
    if (!changed) return;
    const previous = current;
    const before = state;
    const after: SharedTeamRoleState = choice.kind === "admin"
      ? { admin: true, setId: null }
      : choice.kind === "custom" ? { admin: false, setId: choice.setId } : { admin: false, setId: null };
    setBusy(true);
    setError(null);
    try {
      await run(before, choice);
      setOpen(false);
      setQuery("");
      toast({
        title: `${team.name} is now ${chosenTitle}`,
        action: { label: "Undo", onClick: () => { void run(after, previous); } },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change the role.");
    } finally {
      setBusy(false);
    }
  }

  const row = (option: PickerOption) => {
    const selected = sameSharedTeamRole(option.role, choice);
    const reason = sameSharedTeamRole(option.role, current) ? null : sharedTeamRoleLockReason(state, option.role, abilities);
    const id = option.role.kind === "custom" ? option.role.setId : option.role.kind;
    return (
      <button
        key={id}
        type="button"
        role="option"
        aria-selected={selected}
        aria-disabled={reason !== null}
        disabled={reason !== null}
        onClick={() => setChoice(option.role)}
        data-testid={`team-role-option-${id}`}
        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors disabled:cursor-not-allowed ${selected ? "bg-gray-100" : "hover:bg-gray-50"}`}
      >
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[13px] font-medium ${reason ? "text-gray-600" : "text-gray-900"}`}>{option.title}</span>
          <span className="block truncate text-[12px] text-gray-500">{reason ?? option.description}</span>
        </span>
        {selected ? <Check className="h-4 w-4 shrink-0 text-gray-900" aria-hidden /> : reason ? <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden /> : null}
      </button>
    );
  };

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? (setChoice(current), setOpen(true)) : close())}>
      <Popover.Trigger
        disabled={disabled}
        data-testid="team-role-change"
        className={`${buttonVariants({ variant: "secondary", size: "sm" })} gap-1.5`}
      >
        Change role
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Popover.Popup
            data-testid="team-role-choice"
            className="w-[340px] max-w-[calc(100vw-2rem)] rounded-2xl border border-gray-200 bg-white p-2 shadow-[0_8px_24px_rgba(15,23,42,0.08)] outline-none"
          >
            <Popover.Title className="sr-only">Role for {team.name}</Popover.Title>
            <label className="flex h-9 items-center gap-2 rounded-lg border border-gray-200 px-3 focus-within:border-gray-400">
              <Search className="h-3.5 w-3.5 text-gray-500" aria-hidden />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search roles"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-gray-900 outline-none placeholder:text-gray-500"
              />
            </label>
            <div className="mt-1 max-h-[320px] overflow-y-auto" role="listbox" aria-label={`Roles for ${team.name}`}>
              {visibleBuiltIn.map(row)}
              {visibleCustom.length > 0 ? <p className="px-3 pb-1 pt-2 text-[12px] font-medium text-gray-500">Custom roles</p> : null}
              {visibleCustom.map(row)}
              {visibleBuiltIn.length === 0 && visibleCustom.length === 0 ? (
                <p className="px-3 py-4 text-center text-[12px] text-gray-500">No roles match “{query.trim()}”.</p>
              ) : null}
            </div>
            {error ? <DenNotice tone="error" className="mt-2" message={error} /> : null}
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-gray-100 px-1 pt-2">
              <Link href={newRoleHref} className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[12px] font-medium text-gray-700 transition-colors hover:bg-gray-50">
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Create role
              </Link>
              <span className="flex min-w-0 gap-2">
                <DenButton size="sm" variant="secondary" className="shrink-0" onClick={close}>Cancel</DenButton>
                <DenButton
                  size="sm"
                  disabled={!changed}
                  loading={busy}
                  onClick={() => void save()}
                  className="min-w-0"
                  title={changed ? `Change to ${chosenTitle}` : undefined}
                  data-testid="team-role-save"
                >
                  <span className="truncate">{changed ? `Change to ${chosenTitle}` : "Change role"}</span>
                </DenButton>
              </span>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
