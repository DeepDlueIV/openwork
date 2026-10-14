"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import {
  AGENT_PERMISSION_DEFAULT_DECISION,
  AGENT_PERMISSION_EVERYONE,
  agentPermissionDecisionLabels,
  agentPermissionDecisionsFor,
  agentPermissionDefinitions,
  agentPermissionPatternErrors,
  agentPermissionPatternPlaceholders,
  agentPermissionSections,
  decideAgentPermission,
  normalizeAgentPermissionPattern,
  normalizeAgentPermissionSetting,
  normalizeAgentPermissionSettings,
  resolveAgentPermissionRules,
  type AgentPermissionAction,
  type AgentPermissionDecision,
  type AgentPermissionDefinition,
  type AgentPermissionSetting,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions";
import { Check, ChevronRight, CircleHelp, Lock, LockKeyhole, Plus, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenSwitch } from "../../_components/ui/switch";
import { DenSelect } from "../../_components/ui/select";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../_components/ui/tooltip";
import {
  getAgentPermissionsRoute,
  getAgentPermissionsScopeRoute,
  getMembersRoute,
  getNewTeamAgentPermissionsRoute,
  getOrgAccessFlags,
  orgFeatureEnabled,
  permissionLockReason,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  EVERYONE_SCOPE,
  hasTeamRecord,
  useAgentPermissions,
  useRemoveTeamAgentPermissions,
  useSaveAgentPermissions,
  type AgentPermissionPolicies,
  type AgentPermissionPolicy,
  type AgentPermissionScopeId,
} from "./agent-permissions-data";
import { useDenToast } from "./den-toast";
import { LinkButton } from "./item-list";
import { PermissionAreaSection, PermissionsPage } from "./permissions-ui";

const TITLE = "Agent permissions";

function sameSettings(left: AgentPermissionSettings, right: AgentPermissionSettings): boolean {
  return JSON.stringify(normalizeAgentPermissionSettings(left)) === JSON.stringify(normalizeAgentPermissionSettings(right));
}

function sameSetting(definition: AgentPermissionDefinition, left: AgentPermissionSetting | undefined, right: AgentPermissionSetting | undefined): boolean {
  return JSON.stringify(normalizeAgentPermissionSetting(definition, left)) === JSON.stringify(normalizeAgentPermissionSetting(definition, right));
}

function withSetting(settings: AgentPermissionSettings, key: AgentPermissionDefinition["key"], setting: AgentPermissionSetting | null): AgentPermissionSettings {
  const next = { ...settings };
  if (setting && (setting.decision || setting.allow?.length || setting.block?.length)) next[key] = setting;
  else delete next[key];
  return next;
}

function setCount(settings: AgentPermissionSettings): number {
  return Object.keys(normalizeAgentPermissionSettings(settings)).length;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function formatUpdated(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `Updated ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

/** Who a record applies to, as state (DESIGN.md P1), like Permissions' rows. */
function appliesTo(policy: AgentPermissionPolicy, memberCount: number): string {
  return policy.scopeId === EVERYONE_SCOPE
    ? `Everyone in the organization, ${plural(memberCount, "member", "members")}`
    : `${policy.name} team, ${plural(policy.memberCount ?? 0, "member", "members")}`;
}

function setSummary(policy: AgentPermissionPolicy): string {
  const count = setCount(policy.settings);
  if (policy.scopeId === EVERYONE_SCOPE) return count === 0 ? "Everything allowed" : `${plural(count, "permission", "permissions")} set`;
  return `${plural(count, "override", "overrides")}`;
}

type AgentPermissionsAccess =
  | { state: "checking" | "error" | "feature_off" | "no_access" }
  | { state: "ready"; orgId: string; orgSlug: string | null; canManage: boolean; memberCount: number };

function useAgentPermissionsAccess(): AgentPermissionsAccess {
  const { orgId, orgSlug, orgContext, orgBusy, orgError } = useOrgDashboard();
  if (orgError && !orgBusy) return { state: "error" };
  if (orgBusy || !orgContext || !orgId) return { state: "checking" };
  if (!orgFeatureEnabled(orgContext, "agentPermissions")) return { state: "feature_off" };
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);
  if (!access.canViewAgentPermissions) return { state: "no_access" };
  return { state: "ready", orgId, orgSlug, canManage: access.canManageAgentPermissions, memberCount: orgContext.members.length };
}

function AccessState({ access }: { access: AgentPermissionsAccess }) {
  const { refreshOrgData } = useOrgDashboard();
  if (access.state === "feature_off") {
    return (
      <div className="flex flex-col items-start gap-3" data-testid="agent-permissions-feature-off">
        <DenNotice tone="neutral" icon={Lock} message="Agent permissions is an Enterprise feature. Contact us to turn it on for your organization." className="w-full" />
      </div>
    );
  }
  if (access.state === "no_access") return <DenNotice tone="neutral" icon={Lock} message={permissionLockReason("agent_permissions.view")} />;
  if (access.state === "error") {
    return <DenNotice tone="error" message="Couldn't verify workspace access." action={<DenButton variant="secondary" size="sm" onClick={() => void refreshOrgData()}>Try again</DenButton>} />;
  }
  return <EditorSkeleton />;
}

/** Loads every record, then renders `children` with them, or the loading and error states. */
function WithPolicies({ orgId, children }: { orgId: string; children: (data: AgentPermissionPolicies) => React.ReactNode }) {
  const query = useAgentPermissions(orgId);
  if (query.isPending) return <EditorSkeleton />;
  if (query.isError) {
    return (
      <DenNotice
        tone="error"
        message={query.error instanceof Error ? query.error.message : "Couldn't load agent permissions."}
        action={<DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton>}
      />
    );
  }
  return <>{children(query.data)}</>;
}

function ReadOnlyNotice() {
  return <DenNotice tone="neutral" icon={LockKeyhole} message={<span id="agent-permissions-read-only">Read only. {permissionLockReason("agent_permissions.manage")}</span>} />;
}

// ---------------------------------------------------------------------------
// The list: Everyone and every team that has its own record
// ---------------------------------------------------------------------------

export function AgentPermissionsScreen() {
  const access = useAgentPermissionsAccess();
  if (access.state !== "ready") return <PermissionsPage title={TITLE} testId="agent-permissions-landing"><AccessState access={access} /></PermissionsPage>;
  const newButton = access.canManage ? (
    <LinkButton href={getNewTeamAgentPermissionsRoute(access.orgSlug)} variant="secondary" size="sm" data-testid="new-team-agent-permissions">
      <Plus className="size-3.5" aria-hidden="true" />
      Create team agent permissions
    </LinkButton>
  ) : (
    <DenButton variant="secondary" size="sm" icon={LockKeyhole} disabled aria-describedby="agent-permissions-read-only">Create team agent permissions</DenButton>
  );
  return (
    <PermissionsPage title={TITLE} testId="agent-permissions-landing">
      {!access.canManage ? <ReadOnlyNotice /> : null}
      <WithPolicies orgId={access.orgId}>
        {(data) => {
          const teams = data.teams.filter(hasTeamRecord);
          return (
            <>
              <div className="flex flex-col gap-2">
                <PermissionAreaSection label="Defaults" testId="agent-permissions-defaults">
                  <PolicyRow policy={data.everyone} memberCount={access.memberCount} href={getAgentPermissionsScopeRoute(access.orgSlug, EVERYONE_SCOPE)} />
                </PermissionAreaSection>
                <p className="text-[12px] text-gray-500">Everyone's agent permissions apply to every member, unless their team has its own. Agents follow them in desktop apps on OpenCode v2.</p>
              </div>
              <PermissionAreaSection label="Team agent permissions" meta={newButton} testId="agent-permissions-teams">
                {teams.length === 0 ? (
                  <div className="flex min-h-12 items-center py-3 text-[13px] text-gray-500" data-testid="agent-permissions-teams-empty">
                    No team agent permissions yet.
                  </div>
                ) : teams.map((policy) => (
                  <PolicyRow key={policy.scopeId} policy={policy} memberCount={access.memberCount} href={getAgentPermissionsScopeRoute(access.orgSlug, policy.scopeId)} />
                ))}
              </PermissionAreaSection>
            </>
          );
        }}
      </WithPolicies>
    </PermissionsPage>
  );
}

function PolicyRow({ policy, memberCount, href }: { policy: AgentPermissionPolicy; memberCount: number; href: string }) {
  return (
    <Link
      href={href}
      data-testid={`agent-permissions-row-${policy.scopeId}`}
      className="group flex min-h-12 items-center gap-3 py-2 transition-colors hover:bg-gray-50/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium text-gray-900">{policy.name}</span>
        <span className="truncate text-[12px] text-gray-500">{appliesTo(policy, memberCount)}</span>
      </div>
      <span className="shrink-0 text-[12px] text-gray-700">{setSummary(policy)}</span>
      <ChevronRight className="size-4 shrink-0 text-gray-500 transition-colors group-hover:text-gray-700" aria-hidden="true" strokeWidth={1.5} />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Create: choose a team without its own record, set what differs from Everyone
// ---------------------------------------------------------------------------

export function NewTeamAgentPermissionsScreen() {
  const access = useAgentPermissionsAccess();
  const title = "New team agent permissions";
  if (access.state !== "ready") return <PermissionsPage title={title} testId="new-team-agent-permissions"><AccessState access={access} /></PermissionsPage>;
  const back = { href: getAgentPermissionsRoute(access.orgSlug), label: TITLE };
  return (
    <PermissionsPage title={title} back={back} testId="new-team-agent-permissions">
      <WithPolicies orgId={access.orgId}>
        {(data) => <NewTeamAgentPermissions access={access} data={data} />}
      </WithPolicies>
    </PermissionsPage>
  );
}

function NewTeamAgentPermissions({ access, data }: { access: Extract<AgentPermissionsAccess, { state: "ready" }>; data: AgentPermissionPolicies }) {
  const router = useRouter();
  const toast = useDenToast();
  const save = useSaveAgentPermissions(access.orgId);
  const [teamId, setTeamId] = useState("");
  const [settings, setSettings] = useState<AgentPermissionSettings>({});
  const [error, setError] = useState<string | null>(null);
  const teams = data.teams.filter((policy) => !hasTeamRecord(policy)).sort((a, b) => a.name.localeCompare(b.name));
  const team = teams.find((entry) => entry.scopeId === teamId) ?? null;
  const count = setCount(settings);

  if (teams.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 py-2" data-testid="new-team-agent-permissions-empty">
        <p className="text-[13px] text-gray-600">{data.teams.length === 0 ? "No teams yet. Create a team first, then give it agent permissions." : "Every team already has agent permissions."}</p>
        {data.teams.length === 0 ? <LinkButton href={getMembersRoute(access.orgSlug)} variant="secondary" size="sm">Go to Members</LinkButton> : null}
      </div>
    );
  }

  async function create() {
    if (!team || count === 0) return;
    setError(null);
    try {
      await save.mutateAsync([{ scopeId: team.scopeId, settings: normalizeAgentPermissionSettings(settings) }]);
      toast({ title: `Created agent permissions for ${team.name}`, description: "Members' apps apply them the next time they refresh." });
      router.replace(getAgentPermissionsScopeRoute(access.orgSlug, team.scopeId));
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Couldn't create these agent permissions. Try again.");
    }
  }

  return (
    <>
      <div className="flex max-w-sm flex-col gap-1.5">
        <span id="new-team-agent-permissions-team-label" className="text-[13px] font-medium text-gray-700">Team</span>
        <DenSelect aria-labelledby="new-team-agent-permissions-team-label" data-testid="new-team-agent-permissions-team" value={teamId} onChange={(event) => { setError(null); setTeamId(event.target.value); }}>
          <option value="">Choose a team</option>
          {teams.map((entry) => <option key={entry.scopeId} value={entry.scopeId}>{entry.name}</option>)}
        </DenSelect>
        <p className="text-[12px] text-gray-500">Anything left as is follows Everyone's agent permissions.</p>
      </div>
      {error ? <DenNotice tone="error" message={error} /> : null}
      <SettingsEditor
        scopeId={team?.scopeId ?? "new"}
        team={team?.name ?? "This team"}
        settings={settings}
        base={{}}
        everyone={data.everyone.settings}
        editable
        onChange={(next) => { setError(null); setSettings(next); }}
      />
      <DenStickyActionBar testId="new-team-agent-permissions-save-bar" summary={<span>{team ? `${plural(count, "override", "overrides")} for ${team.name}` : "Choose a team to save"}</span>}>
        <LinkButton variant="secondary" href={getAgentPermissionsRoute(access.orgSlug)}>Cancel</LinkButton>
        <DenButton disabled={!team || count === 0} loading={save.isPending} onClick={() => void create()}>Create team agent permissions</DenButton>
      </DenStickyActionBar>
    </>
  );
}

// ---------------------------------------------------------------------------
// One record: Everyone's or a team's
// ---------------------------------------------------------------------------

export function AgentPermissionsScopeScreen({ scopeId }: { scopeId: AgentPermissionScopeId }) {
  const access = useAgentPermissionsAccess();
  if (access.state !== "ready") return <PermissionsPage title={TITLE} testId="agent-permissions-scope"><AccessState access={access} /></PermissionsPage>;
  const back = { href: getAgentPermissionsRoute(access.orgSlug), label: TITLE };
  return (
    <WithPolicies orgId={access.orgId}>
      {(data) => {
        const policy = scopeId === EVERYONE_SCOPE ? data.everyone : data.teams.find((entry) => entry.scopeId === scopeId && hasTeamRecord(entry));
        if (!policy) {
          return (
            <PermissionsPage title={TITLE} back={back} testId="agent-permissions-scope">
              <DenNotice tone="neutral" message="These agent permissions don't exist anymore. Go back to Agent permissions to see what's current." />
            </PermissionsPage>
          );
        }
        return <ScopeEditor key={`${policy.scopeId}-${policy.updatedAt ?? ""}`} access={access} data={data} policy={policy} back={back} />;
      }}
    </WithPolicies>
  );
}

function ScopeEditor({ access, data, policy, back }: {
  access: Extract<AgentPermissionsAccess, { state: "ready" }>;
  data: AgentPermissionPolicies;
  policy: AgentPermissionPolicy;
  back: { href: string; label: string };
}) {
  const save = useSaveAgentPermissions(access.orgId);
  const toast = useDenToast();
  const [draft, setDraft] = useState<AgentPermissionSettings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editable = data.canEdit;
  const isTeam = policy.scopeId !== EVERYONE_SCOPE;
  const settings = draft ?? policy.settings;
  const dirty = draft !== null && !sameSettings(draft, policy.settings);
  const updated = formatUpdated(policy.updatedAt);
  const caption = [appliesTo(policy, access.memberCount), setSummary({ ...policy, settings }), updated].filter(Boolean).join(" · ");

  async function saveSettings(next: AgentPermissionSettings) {
    try {
      await save.mutateAsync([{ scopeId: policy.scopeId, settings: next }]);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error && error.message ? error.message : "Couldn't save agent permissions. Try again.");
      return false;
    }
  }

  async function handleSave() {
    if (!draft) return;
    const previous = policy.settings;
    setSaveError(null);
    if (!(await saveSettings(normalizeAgentPermissionSettings(draft)))) return;
    setDraft(null);
    toast({
      title: "Agent permissions saved",
      description: "Members' apps apply them the next time they refresh.",
      action: {
        label: "Undo",
        onClick: async () => {
          if (await saveSettings(previous)) toast({ title: "Agent permissions restored" });
        },
      },
    });
  }

  return (
    <PermissionsPage
      title={policy.name}
      back={back}
      caption={<span data-testid="agent-permissions-scope-state">{caption}</span>}
      action={isTeam && access.canManage ? <RemoveTeamAgentPermissions access={access} policy={policy} /> : undefined}
      testId="agent-permissions-scope"
    >
      {!editable ? <ReadOnlyNotice /> : null}
      <SettingsEditor
        scopeId={policy.scopeId}
        team={isTeam ? policy.name : null}
        settings={settings}
        base={policy.settings}
        everyone={data.everyone.settings}
        editable={editable}
        onChange={(next) => { setSaveError(null); setDraft(next); }}
      />
      {saveError ? <DenNotice tone="error" message={saveError} /> : null}
      {dirty ? (
        <DenStickyActionBar testId="agent-permissions-save-bar" summary={<span>Unsaved changes for {policy.name}</span>}>
          <DenButton variant="ghost" size="sm" disabled={save.isPending} onClick={() => { setDraft(null); setSaveError(null); }}>Discard</DenButton>
          <DenButton variant="primary" size="sm" loading={save.isPending} disabled={!editable} onClick={() => void handleSave()}>Save changes</DenButton>
        </DenStickyActionBar>
      ) : null}
    </PermissionsPage>
  );
}

function RemoveTeamAgentPermissions({ access, policy }: { access: Extract<AgentPermissionsAccess, { state: "ready" }>; policy: AgentPermissionPolicy }) {
  const router = useRouter();
  const toast = useDenToast();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const remove = useRemoveTeamAgentPermissions(access.orgId, policy.scopeId);

  async function confirm() {
    try {
      await remove.mutateAsync();
      setOpen(false);
      toast({ title: `Removed agent permissions for ${policy.name}` });
      router.push(getAgentPermissionsRoute(access.orgSlug));
    } catch {
      return;
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!remove.isPending) { remove.reset(); setOpen(next); } }}>
      <AlertDialog.Trigger className={buttonVariants({ variant: "secondary", size: "sm" })} data-testid="remove-team-agent-permissions">Remove</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
        <AlertDialog.Popup initialFocus={cancelRef} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-gray-200 bg-white p-5 outline-none">
          <AlertDialog.Title className="text-[15px] font-medium text-gray-950">Remove agent permissions for {policy.name}?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[13px] leading-5 text-gray-600">
            People in {policy.name} get Everyone's agent permissions again the next time their apps refresh.
          </AlertDialog.Description>
          {remove.error ? <DenNotice tone="error" className="mt-3" message={remove.error.message} /> : null}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close ref={cancelRef} disabled={remove.isPending} className={buttonVariants({ variant: "secondary" })}>Cancel</AlertDialog.Close>
            <DenButton variant="destructive" loading={remove.isPending} onClick={() => void confirm()}>Remove permissions</DenButton>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** Every permission for one record, then Try a request. */
function SettingsEditor({ scopeId, team, settings, base, everyone, editable, onChange }: {
  scopeId: AgentPermissionScopeId;
  /** The team's name, or null for Everyone's record. */
  team: string | null;
  settings: AgentPermissionSettings;
  /** What is saved, to mark edited rows. */
  base: AgentPermissionSettings;
  everyone: AgentPermissionSettings;
  editable: boolean;
  onChange: (settings: AgentPermissionSettings) => void;
}) {
  // Blocking file edits blocks every command too (any command can change files).
  const editsBlocked = (team === null ? settings.fileEdits?.decision : settings.fileEdits?.decision ?? everyone.fileEdits?.decision) === "deny";
  return (
    <div className="min-w-0" data-testid="agent-permissions-editor" data-scope={scopeId}>
      <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
        {agentPermissionSections.map((section) => (
          <div key={section.id} className="py-1">
            <h3 className="px-4 pb-1 pt-3 text-[12px] font-medium text-gray-500">{section.label}</h3>
            {agentPermissionDefinitions.filter((definition) => definition.section === section.id).map((definition) => (
              <PermissionRow
                key={`${scopeId}-${definition.key}`}
                definition={definition}
                team={team}
                setting={settings[definition.key]}
                everyoneSetting={team === null ? settings[definition.key] : everyone[definition.key]}
                edited={!sameSetting(definition, settings[definition.key], base[definition.key])}
                editable={editable}
                blockedByEdits={definition.action === "shell" && editsBlocked}
                onChange={(setting) => onChange(withSetting(settings, definition.key, setting))}
              />
            ))}
          </div>
        ))}
      </div>
      <TryRequest everyone={team === null ? settings : everyone} team={team === null ? null : { name: team, settings }} />
    </div>
  );
}

function decisionText(decision: AgentPermissionDecision, definition: AgentPermissionDefinition): string {
  if (definition.control === "toggle") return decision === "deny" ? "Off" : "On";
  return agentPermissionDecisionLabels[decision];
}

function PermissionRow({ definition, team, setting, everyoneSetting, edited, editable, blockedByEdits = false, onChange }: {
  definition: AgentPermissionDefinition;
  /** The team's name, or null when editing everyone's permissions. */
  team: string | null;
  setting: AgentPermissionSetting | undefined;
  everyoneSetting: AgentPermissionSetting | undefined;
  edited: boolean;
  editable: boolean;
  /** Commands while file edits are blocked: every command is blocked too. */
  blockedByEdits?: boolean;
  onChange: (setting: AgentPermissionSetting | null) => void;
}) {
  const labelId = useId();
  const inheritedDecision = everyoneSetting?.decision ?? AGENT_PERMISSION_DEFAULT_DECISION;
  const ownDecision = setting?.decision;
  const effective = team ? ownDecision ?? inheritedDecision : ownDecision ?? AGENT_PERMISSION_DEFAULT_DECISION;
  const overridden = team !== null && ownDecision !== undefined;
  // Everyone's default already allows, so choosing Allow there stores nothing;
  // a team's Allow is kept because it overrides everyone's decision.
  const setDecision = (decision: AgentPermissionDecision | undefined) =>
    onChange({ ...setting, decision: team === null && decision === AGENT_PERMISSION_DEFAULT_DECISION ? undefined : decision });
  const restricted = effective !== "allow";
  const lists = definition.patterns;
  const inheritedAllow = team ? everyoneSetting?.allow ?? [] : [];
  const inheritedBlock = team ? everyoneSetting?.block ?? [] : [];

  return (
    <div className="px-4 py-2.5" data-testid={`agent-permission-${definition.key}`} data-decision={effective}>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <span id={labelId} className="text-[13px] font-medium text-gray-900">{definition.label}</span>
          <Tooltip>
            <TooltipTrigger
              aria-label={`About ${definition.label}`}
              className="rounded text-gray-500 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-gray-900"
            >
              <CircleHelp className="size-3.5" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>{definition.description}</TooltipContent>
          </Tooltip>
          {edited ? <span className="size-1.5 rounded-full bg-sky-500" aria-label="Unsaved change" /> : null}
          {/* A team's value comes from Everyone until the team changes it (inherited, then overridden). */}
          {team ? (
            overridden
              ? <DenChip tone="info" data-testid={`agent-permission-${definition.key}-source`}>Overridden</DenChip>
              : <DenChip data-testid={`agent-permission-${definition.key}-source`}>From Everyone</DenChip>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {overridden && editable ? (
            <button
              type="button"
              aria-label={`Use Everyone's setting for ${definition.label}`}
              title={`Everyone's: ${decisionText(inheritedDecision, definition)}`}
              onClick={() => setDecision(undefined)}
              className="inline-flex items-center gap-1 rounded px-1 text-[12px] text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-gray-900"
            >
              <RotateCcw className="size-3" aria-hidden="true" />
              Use Everyone's
            </button>
          ) : null}
          {definition.control === "toggle" ? (
            <div className="flex items-center gap-2 text-[13px]">
              <span className="text-gray-700" aria-hidden="true">{effective === "allow" ? "Allowed" : "Blocked"}</span>
              <DenSwitch
                size="sm"
                aria-label={definition.label}
                checked={effective === "allow"}
                disabled={!editable}
                onChange={(checked) => setDecision(checked ? "allow" : "deny")}
              />
            </div>
          ) : (
            <div className="w-[190px]">
              <DenSelect
                aria-labelledby={labelId}
                disabled={!editable}
                value={effective}
                onChange={(event) => setDecision(agentPermissionDecisionsFor(definition).find((decision) => decision === event.target.value))}
              >
                {agentPermissionDecisionsFor(definition).map((decision) => (
                  <option key={decision} value={decision}>{agentPermissionDecisionLabels[decision]}</option>
                ))}
              </DenSelect>
            </div>
          )}
        </div>
      </div>
      {blockedByEdits ? (
        <p className="mt-1 flex items-center gap-1.5 text-[12px] text-gray-600 sm:pl-4" data-testid={`agent-permission-${definition.key}-blocked-by-edits`}>
          <Lock className="size-3.5 shrink-0" aria-hidden="true" />
          Blocked while Edit files is blocked, because any command can change files.
        </p>
      ) : null}
      {lists && definition.patternNoun ? (
        <PatternLists
          definitionKey={definition.key}
          label={definition.label}
          kind={lists}
          noun={definition.patternNoun}
          setting={setting}
          inheritedAllow={inheritedAllow}
          inheritedBlock={inheritedBlock}
          restricted={restricted}
          editable={editable}
          onChange={onChange}
        />
      ) : null}
    </div>
  );
}

type PatternListKind = "allow" | "block";

function PatternLists({ definitionKey, label, kind, noun, setting, inheritedAllow, inheritedBlock, restricted, editable, onChange }: {
  definitionKey: AgentPermissionDefinition["key"];
  label: string;
  kind: NonNullable<AgentPermissionDefinition["patterns"]>;
  noun: string;
  setting: AgentPermissionSetting | undefined;
  inheritedAllow: string[];
  inheritedBlock: string[];
  /** The permission asks first or blocks, so allowed patterns are exceptions that matter. */
  restricted: boolean;
  editable: boolean;
  onChange: (setting: AgentPermissionSetting | null) => void;
}) {
  const [picked, setPicked] = useState<PatternListKind | null>(null);
  const lists: Record<PatternListKind, { patterns: string[]; inherited: string[] }> = {
    allow: { patterns: setting?.allow ?? [], inherited: inheritedAllow },
    block: { patterns: setting?.block ?? [], inherited: inheritedBlock },
  };
  const count = (list: PatternListKind) => lists[list].patterns.length + lists[list].inherited.length;
  // Allowed patterns only matter while the permission asks first or blocks.
  const allowUseful = restricted || count("allow") > 0;
  // Open on the exceptions that matter: allowed ones when restricted, blocked ones otherwise.
  const preferred: PatternListKind = picked ?? (restricted ? "allow" : "block");
  const active: PatternListKind = preferred === "allow" && !allowUseful ? "block" : preferred;
  if (!editable && count("allow") + count("block") === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2 pb-1 sm:pl-4" data-testid={`agent-permission-${definitionKey}-lists`}>
      <DenSegmented<PatternListKind>
        aria-label={`${label}: always allowed and always blocked`}
        value={active}
        onChange={setPicked}
        optionTestId={(list) => `agent-permission-${definitionKey}-${list}-add`}
        className="self-start"
        options={[
          { value: "allow", label: `Always allow · ${count("allow")}`, disabled: !allowUseful },
          { value: "block", label: `Always block · ${count("block")}` },
        ]}
      />
      <PatternList
        key={active}
        list={active}
        noun={noun}
        testId={`agent-permission-${definitionKey}-${active}`}
        kind={kind}
        patterns={lists[active].patterns}
        inherited={lists[active].inherited}
        editable={editable}
        onChange={(patterns) => onChange({ ...setting, [active]: patterns })}
      />
    </div>
  );
}

function PatternList({ list, noun, testId, kind, patterns, inherited, editable, onChange }: {
  list: PatternListKind;
  noun: string;
  testId: string;
  kind: NonNullable<AgentPermissionDefinition["patterns"]>;
  patterns: string[];
  inherited: string[];
  editable: boolean;
  onChange: (patterns: string[]) => void;
}) {
  const errorId = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const action = list === "allow" ? `Always allow a ${noun}` : `Always block a ${noun}`;
  const title = list === "allow" ? "Always allowed" : "Always blocked";

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pattern = normalizeAgentPermissionPattern(kind, draft);
    if (pattern === null) {
      setError(agentPermissionPatternErrors[kind]);
      return;
    }
    if (patterns.includes(pattern) || inherited.includes(pattern)) {
      setError(`${pattern} is already on this list.`);
      return;
    }
    setError(null);
    setDraft("");
    onChange([...patterns, pattern]);
  }

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {editable ? (
        <form onSubmit={add} className="flex max-w-[420px] items-center gap-2">
          <DenInput
            aria-label={action}
            data-testid={`${testId}-input`}
            value={draft}
            placeholder={agentPermissionPatternPlaceholders[kind]}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="h-8 font-mono text-[12px]"
            onChange={(event) => { setDraft(event.target.value); setError(null); }}
            onKeyDown={(event) => { if (event.key === "Escape") { setDraft(""); setError(null); } }}
          />
          <DenButton type="submit" variant="secondary" size="sm" icon={Plus} disabled={!draft.trim()}>Add</DenButton>
        </form>
      ) : null}
      {error ? <p id={errorId} className="text-[12px] text-red-600">{error}</p> : null}
      {inherited.length > 0 || patterns.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-1.5" aria-label={title}>
          {inherited.map((pattern) => (
            <li key={`inherited-${pattern}`}>
              <Tooltip>
                <TooltipTrigger className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 font-mono text-[12px] text-gray-500" aria-label={`${pattern}, set for Everyone`}>
                  <Lock className="size-3" aria-hidden="true" />
                  {pattern}
                </TooltipTrigger>
                <TooltipContent>Set for Everyone</TooltipContent>
              </Tooltip>
            </li>
          ))}
          {patterns.map((pattern) => (
            <li key={pattern} className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white py-px pl-2 pr-0.5 font-mono text-[12px] text-gray-800">
              {pattern}
              <button
                type="button"
                aria-label={`Remove ${pattern}`}
                disabled={!editable}
                onClick={() => onChange(patterns.filter((entry) => entry !== pattern))}
                className="rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-gray-500">{list === "allow" ? `No ${noun}s are always allowed.` : `No ${noun}s are always blocked.`}</p>
      )}
    </div>
  );
}

const TRY_KINDS: readonly { action: AgentPermissionAction; label: string; placeholder: string }[] = [
  { action: "shell", label: "Command", placeholder: "git push origin main" },
  { action: "webfetch", label: "Website", placeholder: "https://docs.example.com/guide" },
  { action: "skill", label: "Local skill", placeholder: "meeting-notes" },
  { action: "mcp", label: "Local MCP server", placeholder: "issue-tracker" },
];

function TryRequest({ everyone, team }: { everyone: AgentPermissionSettings; team: { name: string; settings: AgentPermissionSettings } | null }) {
  const [action, setAction] = useState<AgentPermissionAction>("shell");
  const [value, setValue] = useState("");
  const kind = TRY_KINDS.find((entry) => entry.action === action);
  const resource = action === "webfetch" && value.trim() && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) ? `https://${value.trim()}` : value.trim();
  const result = resource
    ? decideAgentPermission(resolveAgentPermissionRules({
        everyone: { source: AGENT_PERMISSION_EVERYONE, settings: everyone },
        teams: team ? [{ source: team.name, settings: team.settings }] : [],
      }), action, [resource])
    : null;
  const definition = agentPermissionDefinitions.find((entry) => entry.action === action);
  const because = result?.rule
    ? result.rule.resource === "*"
      ? `${definition?.label ?? "This"} is set to ${agentPermissionDecisionLabels[result.rule.effect]} for ${result.rule.source}`
      : `Matches "${result.rule.resource}" for ${result.rule.source}`
    : "No permission applies";

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white px-4 py-3" data-testid="agent-permission-try">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[13px] font-medium text-gray-900">Try a request</span>
        <div className="w-[170px]">
          <DenSelect aria-label="Request type" value={action} onChange={(event) => setAction(TRY_KINDS.find((entry) => entry.action === event.target.value)?.action ?? "shell")}>
            {TRY_KINDS.map((entry) => <option key={entry.action} value={entry.action}>{entry.label}</option>)}
          </DenSelect>
        </div>
        <DenInput
          aria-label="Request to try"
          data-testid="agent-permission-try-input"
          className="h-9 min-w-[200px] flex-1 font-mono text-[12px]"
          placeholder={kind?.placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      {result ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-gray-600" data-testid="agent-permission-try-result" data-effect={result.effect} aria-live="polite">
          {result.effect === "deny" ? (
            <DenChip icon={Lock}>Blocked</DenChip>
          ) : result.effect === "ask" ? (
            <DenChip tone="info">Asks first</DenChip>
          ) : (
            <DenChip tone="success" icon={Check}>Allowed</DenChip>
          )}
          <span>{because}</span>
        </p>
      ) : null}
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-gray-200 p-4" data-testid="agent-permissions-loading">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div key={index} className="flex items-center justify-between py-1.5">
          <DenSkeleton className="h-3.5 w-36" />
          <DenSkeleton className="h-8 w-[190px] rounded-lg" />
        </div>
      ))}
    </div>
  );
}
