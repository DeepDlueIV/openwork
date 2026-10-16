import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { TaskRecovery } from "./task-recovery";
import { checkOnlineConnection, type ConnectivityIssue } from "@/react-app/domains/session/status/offline-recovery-store";

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
  if (!props.active || (!props.issue && !props.held)) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-4 bottom-24 z-40 flex justify-end">
      <div className="pointer-events-auto w-full max-w-sm rounded-lg bg-popover px-4 py-2 text-popover-foreground shadow-[var(--dls-card-shadow)]">
        <TaskRecovery compact state="paused" emphasized={Boolean(props.issue)} testId="offline-recovery"
          title={props.issue === "offline" ? "You’re offline" : props.issue ? "Can’t reach online services" : "Connection restored"}
          technicalDetails={props.stopUnconfirmed ? "The task could not be confirmed stopped. Check its status before continuing. Some steps may already have completed."
            : props.interrupted ? "The local task stopped retrying. Some steps may already have completed; continuing checks the conversation before doing what remains." : undefined}
          actions={props.issue ? <Button variant="ghost" size="xs" disabled={props.checking}
            onClick={() => void checkOnlineConnection()}>Check connection</Button>
            : <Button variant="ghost" size="xs" disabled={!props.canContinue || props.stopUnconfirmed} onClick={props.onContinue}>
              {props.interrupted ? "Continue task" : "Continue"}
            </Button>} />
      </div>
    </div>,
    document.body,
  );
}
