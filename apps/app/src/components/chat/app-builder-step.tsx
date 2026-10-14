import { useEffect, useState } from "react";
import { Check, Circle, X } from "lucide-react";
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";
import { formatToolCallDuration } from "@/lib/tool-call-duration";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { useOptionalMessageList } from "./message-list-provider";
import { useCurrentToolLifecycleResolver } from "./current-tool-lifecycle-context";
import {
  appCreationProgress,
  appRead,
  appSourceLines,
  isAppGuidePart,
  type AppCreationRun,
} from "@/react-app/domains/apps/app-creation-progress";
import { appBuilderResultFailed } from "@/react-app/domains/apps/built-mcp-app-model";
import { BuiltAppChatPreview } from "@/react-app/domains/apps/built-app-chat-preview";
import { DetailsToggle, TechnicalDetailsPanel } from "./capability-call-line";
import type { DynamicToolUIPart } from "ai";

/**
 * Den's build rejection, shortened to what changed: "MCP App compilation
 * failed. Generated MCP Apps cannot use timers. Use …" → "Can't use timers".
 */
export function appBuildProblem(part: DynamicToolUIPart): string | null {
  if (part.state !== "output-error" || !part.errorText.trim()) return null;
  const sentences = part.errorText.replace(/\s+/g, " ").trim().split(/(?<=\.)\s+/);
  const reason = sentences.find((sentence) => !/compilation failed|^error:/i.test(sentence)) ?? sentences[0] ?? "";
  return reason
    .replace(/^Generated MCP Apps cannot /i, "Can’t ")
    .replace(/\.$/, "")
    .slice(0, 120) || null;
}

type ChecklistItem = { key: string; label: string; state: "done" | "active" | "failed" };

/**
 * What the agent has done for this App so far, read from its own calls: the
 * guide, searches, the tools prepare_app checked, the source it is writing,
 * each problem it fixed, and the build.
 */
function appCreationChecklist(
  run: AppCreationRun,
  progress: ReturnType<typeof appCreationProgress>,
  fixedProblems: string[],
  latestProblem: string | null,
): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const discoveries = run.discoveries ?? [];
  if (discoveries.some(isAppGuidePart)) items.push({ key: "guide", label: "Read the build guide", state: "done" });
  const searches = discoveries.filter((part) => /(?:^|_)search_capabilities$/.test(part.toolName));
  if (searches.length > 0) {
    const query = Reflect.get(Object(searches.at(-1)?.input), "query");
    items.push({
      key: "search",
      label: searches.length === 1 && typeof query === "string" && query ? `Searched your connections for “${query}”` : `Searched your connections ${searches.length} times`,
      state: searches.some(isToolPartInFlight) ? "active" : "done",
    });
  }
  const read = discoveries.map(appRead).find(Boolean);
  if (read) items.push({ key: "read", label: read.title ? `Read “${read.title}”` : "Read the App", state: "done" });
  if (progress.preparation) {
    const count = progress.preparation.tools.length;
    items.push({ key: "prepare", label: count === 0 ? "Planned an App without tools" : `Checked ${count} ${count === 1 ? "tool" : "tools"}`, state: "done" });
  } else if ((run.preparation && isToolPartInFlight(run.preparation)) || run.script?.kind === "prepare") {
    items.push({ key: "prepare", label: "Checking its tools", state: "active" });
  } else if (run.preparation && appBuilderResultFailed(run.preparation)) {
    items.push({ key: "prepare", label: "Couldn’t check its tools", state: "failed" });
  }
  const build = progress.build;
  const writtenBy = build ?? (run.script && run.script.kind !== "prepare" ? run.script.part : undefined);
  const lines = appSourceLines(writtenBy);
  const size = lines ? ` · ${lines} lines` : "";
  const writing = progress.running && progress.stage === "writing" && (!build || build.state === "input-streaming");
  if (writing) items.push({ key: "write", label: `Writing the view${size}`, state: "active" });
  else if (build && build.state !== "input-streaming") items.push({ key: "write", label: `Wrote the view${size}`, state: "done" });
  fixedProblems.forEach((problem, index) => items.push({ key: `fixed-${index}`, label: `Fixed: ${problem}`, state: "done" }));
  if (build && !writing && build.state !== "input-streaming") {
    if (progress.app || progress.builtUnrecorded) items.push({ key: "build", label: "Compiled and published", state: "done" });
    else if (progress.failed) items.push({ key: "build", label: latestProblem ? `Couldn’t build: ${latestProblem}` : "Couldn’t build it", state: "failed" });
    else if (progress.unavailable) items.push({ key: "build", label: "Built, but the preview is unavailable", state: "failed" });
    else items.push({ key: "build", label: "Compiling and checking", state: progress.running ? "active" : "done" });
  }
  return items;
}

export function AppBuilderStep({
  run,
  active,
}: {
  run: AppCreationRun;
  active: boolean;
}) {
  const context = useOptionalMessageList();
  const resolveLifecycle = useCurrentToolLifecycleResolver();
  const latest = run.builds.at(-1) ?? run.preparation ?? run.discoveries?.at(-1);
  const lifecycle = latest
    ? resolveLifecycle(latest.toolCallId, isToolPartInFlight(latest))
    : null;
  const progress = appCreationProgress(
    run,
    active &&
      !context?.syncDegraded &&
      lifecycle !== "interrupted" &&
      lifecycle !== "waiting",
  );
  const parts = [...(run.executions ?? []), ...(run.attempts ?? []), ...(run.discoveries ?? []), ...(run.preparation ? [run.preparation] : []), ...run.builds];
  const starts = parts.flatMap((part) =>
    typeof part.callProviderMetadata?.openwork?.toolStartedAt === "number"
      ? [part.callProviderMetadata.openwork.toolStartedAt]
      : [],
  );
  const ends = parts.flatMap((part) =>
    typeof part.callProviderMetadata?.openwork?.toolCompletedAt === "number"
      ? [part.callProviderMetadata.openwork.toolCompletedAt]
      : [],
  );
  const [now, setNow] = useState(Date.now);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Earlier rejected builds are progress on the same app, not new apps.
  const fixedProblems = [...(run.attempts ?? []), ...run.builds.slice(0, -1)].flatMap((part) => {
    const problem = appBuildProblem(part);
    return problem ? [problem] : [];
  });
  const latestProblem = progress.build ? appBuildProblem(progress.build) : null;
  useEffect(() => {
    if (!progress.running) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [progress.running]);
  const terminal = progress.app || progress.failed || progress.unavailable;
  const elapsed =
    starts.length && (progress.running || (terminal && ends.length))
      ? Math.max(
          0,
          (progress.running ? now : Math.max(...ends)) - Math.min(...starts),
        )
      : null;
  const editing =
    run.intent?.kind === "edit" ||
    run.script?.kind === "update" ||
    (progress.build && /(?:^|_)update_app$/.test(progress.build.toolName));
  // Shown while the agent works or after it failed; a ready App folds it away.
  const checklist = progress.running || progress.failed
    ? appCreationChecklist(run, progress, fixedProblems, latestProblem)
    : [];
  // One plain rail row, like every other step: what is happening to which
  // app, a short state, Open when there is something to open, and the raw
  // calls behind the details icon.
  const title = progress.title ? ` “${progress.title}”` : "";
  const sentence = progress.app || progress.builtUnrecorded
    ? `${editing ? "Updated" : "Created"} artifact${title}`
    : progress.failed
      ? `Couldn’t ${editing ? "update" : "create"} artifact${title}`
      : progress.stage === "checking"
        ? `Checking artifact${title}`
        : progress.stage === "writing"
          ? `${editing ? "Updating" : "Writing"} artifact${title}`
          : `Preparing artifact${title}`;
  const state = progress.failed
    ? latestProblem
    : progress.builtUnrecorded
      ? "Open it from your Library"
      : progress.unavailable
        ? "Preview unavailable"
        : !progress.running && !progress.app
          ? context?.syncDegraded ? "Reconnecting" : lifecycle === "waiting" ? "Waiting for approval" : "Paused"
          : fixedProblems.length > 0 && progress.running
            ? `fixed ${fixedProblems.length} ${fixedProblems.length === 1 ? "problem" : "problems"}`
            : null;
  const shownElapsed = elapsed !== null && (progress.running || terminal) ? formatToolCallDuration(elapsed) : null;
  return (
    <section
      className="group/step min-w-0"
      data-app-builder-step
      data-app-creation-stage={progress.stage}
      aria-label={sentence}
    >
      <div className="flex min-h-6 min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <img src={resolveExtensionIconSrc("/openwork-mark.svg")} alt="" className="size-4 shrink-0 opacity-80 dark:invert" />
        <span className={`shrink-0 ${progress.running ? "ow-text-shimmer motion-reduce:animate-none" : ""}`}>{sentence}</span>
        {state ? <span className="min-w-0 truncate text-xs text-muted-foreground">{state}</span> : null}
        {shownElapsed ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{shownElapsed}</span> : null}
        {progress.app && progress.build ? <BuiltAppChatPreview part={progress.build} compact /> : null}
        <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)} label={sentence} alwaysVisible={progress.failed} />
      </div>
      {checklist.length > 0 ? (
        <ol className="ml-6 mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground" aria-label={`Progress of ${sentence}`} data-app-builder-checklist>
          {checklist.map((item) => (
            <li key={item.key} className="flex min-w-0 items-center gap-1.5" data-checklist-state={item.state}>
              {item.state === "done"
                ? <Check className="size-3 shrink-0" aria-hidden="true" />
                : item.state === "failed"
                  ? <X className="size-3 shrink-0 text-destructive" aria-hidden="true" />
                  : <Circle className="size-3 shrink-0 animate-pulse motion-reduce:animate-none" aria-hidden="true" />}
              <span className={`min-w-0 truncate ${item.state === "active" ? "ow-text-shimmer motion-reduce:animate-none" : ""}`}>{item.label}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {detailsOpen ? (
        <div className="mt-1 flex flex-col gap-2">
          {fixedProblems.map((problem, index) => (
            <p key={index} className="text-xs text-muted-foreground">Fixed: {problem}</p>
          ))}
          {parts.map((part) => (
            <TechnicalDetailsPanel key={part.toolCallId} part={part} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
