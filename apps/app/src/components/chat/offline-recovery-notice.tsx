import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Toaster, toast } from "@/components/ui/sonner";
import { TaskRecovery } from "./task-recovery";
import { checkOnlineConnection, type ConnectivityIssue } from "@/react-app/domains/session/status/offline-recovery-store";

// Keep the persistent status clear of the composer's send/stop controls.
const notificationOffset = {
  bottom: "calc(env(safe-area-inset-bottom, 0px) + 6rem)",
  right: "1rem",
  left: "1rem",
};

export function OfflineRecoveryNotice(props: {
  active: boolean;
  issue: ConnectivityIssue;
  checking: boolean;
  held: boolean;
  interrupted: boolean;
  stopUnconfirmed: boolean;
  canContinue: boolean;
  onContinue: () => void;
}) {
  const toastId = useId();
  const onContinue = useRef(props.onContinue);
  onContinue.current = props.onContinue;
  const { issue, checking, interrupted, stopUnconfirmed, canContinue } = props;
  const visible = props.active && Boolean(issue || props.held);

  useEffect(() => {
    if (!visible) {
      toast.dismiss(toastId);
      return;
    }
    toast.custom(() => (
      <div className="w-full rounded-lg bg-popover px-4 py-2 text-popover-foreground shadow-[var(--dls-card-shadow)]">
        <TaskRecovery compact state="paused" emphasized={Boolean(issue)} testId="offline-recovery"
          title={issue === "offline" ? "You’re offline" : issue ? "Can’t reach online services" : "Connection restored"}
          technicalDetails={stopUnconfirmed ? "The task could not be confirmed stopped. Check its status before continuing. Some steps may already have completed."
            : interrupted ? "The local task stopped retrying. Some steps may already have completed; continuing checks the conversation before doing what remains." : undefined}
          actions={issue ? <Button variant="ghost" size="xs" disabled={checking}
            onClick={() => void checkOnlineConnection()}>Check connection</Button>
            : <Button variant="ghost" size="xs" disabled={!canContinue || stopUnconfirmed} onClick={() => onContinue.current()}>
              {interrupted ? "Continue task" : "Continue"}
            </Button>} />
      </div>
    ), { id: toastId, toasterId: toastId, position: "bottom-right", duration: Infinity, dismissible: false });
  }, [visible, issue, checking, interrupted, stopUnconfirmed, canContinue, toastId]);

  useEffect(() => () => { toast.dismiss(toastId); }, [toastId]);

  // Sonner only receives events after its host subscribes. Keep the active
  // conversation’s host mounted before the first connection warning arrives.
  return props.active ? <Toaster id={toastId} position="bottom-right" offset={notificationOffset} mobileOffset={notificationOffset} /> : null;
}
