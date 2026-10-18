"use client";

import { Popover } from "@base-ui/react/popover";
import { Check, Copy, Lock, Share2 } from "lucide-react";
import { useState } from "react";
import { workbotHost } from "./host";

/** A link is not an invitation. No email or membership write uses a Workbot token here. */
export function ShareWorkbot() {
  const share = workbotHost().shareWorkbot;
  const [url, setUrl] = useState("");
  const [state, setState] = useState<"ready" | "copied" | "failed">("ready");
  if (!share) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return <Popover.Root onOpenChange={open => {
    if (open) { setUrl(window.location.href); setState("ready"); }
  }}>
    <Popover.Trigger aria-label="Share Workbot" title="Share Workbot" className="grid size-8 shrink-0 place-items-center rounded-lg text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"><Share2 size={16} strokeWidth={1.5} aria-hidden /></Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={12} className="z-50 max-w-[var(--available-width)]">
        <Popover.Popup className="workbot max-h-[var(--available-height)] w-72 max-w-[var(--available-width)] overflow-y-auto rounded-xl bg-[var(--wb-surface)] p-4 shadow-[var(--wb-panel-shadow)] outline-none">
          <Popover.Title className="text-[13px] font-medium text-[var(--wb-text)]">Share Workbot</Popover.Title>
          {share.enabled ? <>
            <p className="mt-3 text-[12px] text-[var(--wb-muted)]">A link doesn't grant access. Ask your team admin to invite coworkers in Den.</p>
            <input aria-label="Workbot link" readOnly value={url} onFocus={event => event.currentTarget.select()} className="mt-3 h-9 w-full min-w-0 rounded-lg bg-[var(--wb-chip)] px-2 text-[12px] text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" />
            <button type="button" onClick={() => void copy()} className="mt-3 flex min-h-9 items-center gap-2 rounded-lg bg-[var(--wb-ink)] px-3 text-[12px] font-medium text-[var(--wb-on-ink)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">{state === "copied" ? <Check size={16} strokeWidth={1.5} aria-hidden /> : <Copy size={16} strokeWidth={1.5} aria-hidden />}Copy Workbot link</button>
            <p role="status" className="mt-2 text-[12px] text-[var(--wb-muted)]">{state === "copied" ? "Copied Workbot link" : state === "failed" ? "Couldn't copy. Select the link above and copy it manually." : "Only coworkers with access can open Workbot."}</p>
          </> : <p className="mt-3 flex items-start gap-2 text-[12px] text-[var(--wb-muted)]"><Lock size={16} strokeWidth={1.5} className="shrink-0" aria-hidden />Sharing is off. A platform admin can turn it on.</p>}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
