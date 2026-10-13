"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PERMISSION_KEYS, type PermissionKey } from "@openwork/types/den/permissions";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { getMembersRoute, getTeamRoute, orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useDenToast } from "./den-toast";
import { AccessRow, AddPicker, Avatar, RemoveButton } from "./access-rows";
import { ItemPanel, LinkButton } from "./item-list";
import { RolePermissionsNotSavedError, useCreateRole, type PermissionStatus } from "./permissions-data";
import {
  PermissionEditor,
  PermissionsAccessState,
  PermissionsPage,
  usePermissionsAccess,
  type PermissionEditorRow,
  type PermissionsAccess,
} from "./permissions-ui";
import { ROLE_START_LABELS, roleStartKeys, type RoleStart } from "./team-roles";

type ReadyAccess = Extract<PermissionsAccess, { state: "ready" }>;

const START_OPTIONS: readonly RoleStart[] = ["member", "admin", "everything"];

/** Members › Roles › Create role (teamRoles): a team with its people and its permission set. */
export function RoleNewScreen() {
  const permissions = usePermissionsAccess();
  const { orgContext } = useOrgDashboard();
  if (orgContext && !orgFeatureEnabled(orgContext, "teamRoles")) {
    return <PermissionsPage title="Create role" testId="role-new"><DenNotice tone="neutral" message="Roles aren't turned on for this organization yet." /></PermissionsPage>;
  }
  if (permissions.state !== "ready") {
    return <PermissionsPage title="Create role" testId="role-new"><PermissionsAccessState access={permissions} /></PermissionsPage>;
  }
  return <RoleNewContent ready={permissions} />;
}

function RoleNewContent({ ready }: { ready: ReadyAccess }) {
  const router = useRouter();
  const toast = useDenToast();
  const { orgContext } = useOrgDashboard();
  const create = useCreateRole(ready.orgId);
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [start, setStart] = useState<RoleStart>("member");
  // Switches the person changed by hand. Choosing another starting point keeps them.
  const [overrides, setOverrides] = useState<ReadonlyMap<PermissionKey, PermissionStatus>>(new Map());
  const base = new Set(roleStartKeys(start, ready.held));
  const allowed = new Set(PERMISSION_KEYS.filter((key) => (overrides.get(key) ?? (base.has(key) ? "allow" : "deny")) === "allow"));
  const back = { href: `${getMembersRoute(ready.orgSlug)}?tab=roles`, label: "Roles" };

  const people = (orgContext?.members ?? []).filter((member) => member.userId !== null);
  const chosen = memberIds.flatMap((id) => people.find((member) => member.id === id) ?? []);
  const addable = people
    .filter((member) => !memberIds.includes(member.id))
    .map((member) => ({ id: member.id, name: member.user.name || member.user.email, detail: member.user.email }));
  const trimmed = name.trim();

  const rows: PermissionEditorRow[] = PERMISSION_KEYS.map((key) => {
    const status: PermissionStatus = allowed.has(key) ? "allow" : "deny";
    return { key, status, draft: status, lockedReason: ready.held.has(key) ? null : "You don't have this permission" };
  });

  function chooseStart(next: RoleStart) {
    create.reset();
    setStart(next);
  }

  function toggle(key: PermissionKey, next: PermissionStatus) {
    create.reset();
    setOverrides((current) => new Map(current).set(key, next));
  }

  async function submit() {
    if (!trimmed) return;
    try {
      const created = await create.mutateAsync({
        name: trimmed,
        memberIds,
        permissions: [...allowed].map((key) => ({ key, status: "allow" })),
      });
      toast({ title: `${trimmed} created` });
      router.replace(getTeamRoute(ready.orgSlug, created.teamId));
    } catch {
      return;
    }
  }

  const halfMade = create.error instanceof RolePermissionsNotSavedError ? create.error : null;

  return (
    <PermissionsPage title="Create role" back={back} testId="role-new">
      <label className="flex max-w-sm flex-col gap-1.5">
        <span className="text-[13px] font-medium text-gray-700">Name</span>
        <DenInput value={name} onChange={(event) => { create.reset(); setName(event.target.value); }} placeholder="Skill publishers" maxLength={255} data-testid="role-new-name" />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-gray-700">People</span>
        <ItemPanel>
          {chosen.map((member) => {
            const label = member.user.name || member.user.email;
            return (
              <AccessRow
                key={member.id}
                lead={<Avatar name={label} />}
                title={label}
                description={member.user.email}
                trailing={<RemoveButton label={`Remove ${label}`} onClick={() => setMemberIds((current) => current.filter((id) => id !== member.id))} />}
                testId="role-new-person"
              />
            );
          })}
          <div className="flex px-5 py-3">
            <AddPicker kind="person" options={addable} onAdd={(ids) => setMemberIds((current) => [...current, ...ids])} />
          </div>
        </ItemPanel>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-gray-700">Start from</span>
        <DenSegmented
          aria-label="Start from"
          value={start}
          onChange={chooseStart}
          options={START_OPTIONS.map((option) => ({ value: option, label: ROLE_START_LABELS[option] }))}
        />
      </div>

      {halfMade ? (
        <DenNotice
          tone="error"
          message={<>The team was created but its permissions weren't saved: {halfMade.message} <Link className="font-medium underline underline-offset-2" href={getTeamRoute(ready.orgSlug, halfMade.teamId)}>Open the team</Link> to try again.</>}
        />
      ) : create.error ? <DenNotice tone="error" message={create.error.message} /> : null}

      <PermissionEditor rows={rows} onToggle={toggle} />

      <DenStickyActionBar testId="role-new-save-bar" summary={<span>{trimmed ? `${allowed.size} allowed for ${trimmed}` : "Name the role to save"}</span>}>
        <LinkButton variant="secondary" href={back.href}>Cancel</LinkButton>
        <DenButton disabled={!trimmed || halfMade !== null} loading={create.isPending} onClick={() => void submit()} data-testid="role-new-create">Create role</DenButton>
      </DenStickyActionBar>
    </PermissionsPage>
  );
}
