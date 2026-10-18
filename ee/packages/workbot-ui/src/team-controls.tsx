"use client";

import { Popover } from "@base-ui/react/popover";
import { ExternalLink, Lock, Settings } from "lucide-react";
import { workbotHost } from "./host";

/** Team navigation is separate from chat state; Den rechecks access at the destination. */
export function TeamControls() {
  const team = workbotHost().teamLinks;
  if (!team || (!team.settings && !team.apps)) return null;
  const links = [
    ...(team.settings ? [{ label: "Workbot settings", path: "workbot-settings" }] : []),
    ...(team.apps ? [{ label: "Manage apps for your team", path: "mcp-connections" }] : []),
  ];
  const row = "flex min-h-11 items-center justify-between gap-3 rounded-lg px-3 text-[13px] text-[var(--wb-text)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";
  return <Popover.Root>
    <Popover.Trigger aria-label="Team settings" title="Team settings" className="grid size-8 shrink-0 place-items-center rounded-lg text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"><Settings size={16} strokeWidth={1.5} aria-hidden /></Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={12} className="z-50 max-w-[var(--available-width)]">
        <Popover.Popup className="workbot max-h-[var(--available-height)] w-64 max-w-[var(--available-width)] overflow-y-auto rounded-xl bg-[var(--wb-surface)] p-1.5 shadow-[var(--wb-panel-shadow)] outline-none">
          <Popover.Title className="sr-only">Team settings</Popover.Title>
          {links.map(link => team.enabled
            ? <a key={link.path} className={row} href={`${team.denUrl}/dashboard/${link.path}?workbotOrganizationId=${encodeURIComponent(team.organizationId)}`} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={16} strokeWidth={1.5} aria-label="Opens in a new tab" /></a>
            : <div key={link.path} className={row} aria-disabled="true">{link.label}<Lock size={16} strokeWidth={1.5} aria-label="Off for this workspace" /></div>)}
          {!team.enabled && <p className="px-3 pb-2 text-[12px] text-[var(--wb-muted)]">Team links are off. A platform admin can turn them on.</p>}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
