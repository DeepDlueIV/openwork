import type { DynamicToolUIPart, UIMessage } from "ai";
import { prepareMcpAppOutputSchema } from "@openwork/types/mcp-app";
import {
  appBuilderResultFailed,
  builtAppSummary,
  isAppBuilderPart,
} from "./built-mcp-app-model";

export type AppCreationRun = {
  id: string;
  preparation?: DynamicToolUIPart;
  discoveries?: DynamicToolUIPart[];
  executions?: DynamicToolUIPart[];
  builds: DynamicToolUIPart[];
  /** Earlier attempts at this App that were rejected before a retry succeeded. */
  attempts?: DynamicToolUIPart[];
};
export type AppCreationStage = "needs" | "writing" | "checking" | "ready";

export function isAppPreparationPart(part: DynamicToolUIPart): boolean {
  return /(?:^|_)prepare_app$/.test(part.toolName);
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}

export function appPreparation(part: DynamicToolUIPart | undefined) {
  if (
    !part ||
    part.state !== "output-available" ||
    appBuilderResultFailed(part)
  )
    return null;
  const result = field(part.callProviderMetadata?.openwork, "mcpResult");
  const structured = prepareMcpAppOutputSchema.safeParse(
    field(result, "structuredContent"),
  );
  if (structured.success) return structured.data;
  // Both engines also retain the MCP text projection. Older engines can omit metadata.
  let output: unknown = part.output;
  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      return null;
    }
  }
  const parsed = prepareMcpAppOutputSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

/** A step that succeeded but whose result an older engine did not record. */
export function appStepUnrecorded(part: DynamicToolUIPart | undefined): boolean {
  if (!part || part.state !== "output-available") return false;
  const result = field(part.callProviderMetadata?.openwork, "mcpResult");
  return field(field(result, "structuredContent"), "unrecorded") === true;
}

const BUILD_AN_APP_SKILL = /(?:^|[/:])build-an-app$/;

/** Reading the build-an-app guide, directly or as the only work of a Code Mode script. */
function isAppGuideCall(tool: string, input: unknown): boolean {
  if (!/(?:^|[_.])(?:get_skill|skill)$/.test(tool)) return false;
  const name = field(input, "name") ?? field(input, "capability");
  return typeof name === "string" && BUILD_AN_APP_SKILL.test(name);
}

/**
 * Calls that lead into an App step: finding capabilities, reading the
 * build-an-app guide, or reading an App to edit. They join the step the agent
 * opens next; on their own they stay ordinary steps.
 */
function isAppLeadInPart(part: DynamicToolUIPart): boolean {
  if (/(?:^|_)(?:search_capabilities|read_app)$/.test(part.toolName)) return true;
  if (isAppGuideCall(part.toolName, part.input)) return true;
  const calls = field(part.callProviderMetadata?.openwork?.codeMode, "calls");
  return Array.isArray(calls) && calls.length > 0 && calls.every((call) => {
    const tool = field(call, "tool");
    return typeof tool === "string" && isAppGuideCall(tool, field(call, "input"));
  });
}

/**
 * App steps start only where the agent itself starts one: prepare_app, or a
 * create_app or update_app without a preparation. The lookups just before it
 * in the same turn join that step. Builds correlate by the server-issued
 * preparation id, keeping separate Apps and retries separate.
 */
export function appCreationRuns(messages: UIMessage[]): AppCreationRun[] {
  const runs: AppCreationRun[] = [];
  const byPreparation = new Map<string, AppCreationRun>();
  const parts = new Map<string, DynamicToolUIPart>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "dynamic-tool") parts.set(part.toolCallId, part);
    }
  }
  let leadIn: DynamicToolUIPart[] = [];
  const join = (run: AppCreationRun) => {
    if (leadIn.length > 0) run.discoveries = [...(run.discoveries ?? []), ...leadIn];
    leadIn = [];
  };
  for (const part of parts.values()) {
    if (isAppLeadInPart(part)) {
      leadIn.push(part);
    } else if (isAppPreparationPart(part)) {
      const run: AppCreationRun = { id: leadIn[0]?.toolCallId ?? part.toolCallId, preparation: part, builds: [] };
      join(run);
      runs.push(run);
      const preparation = appPreparation(part);
      if (preparation) byPreparation.set(preparation.preparationId, run);
    } else if (isAppBuilderPart(part)) {
      const id = field(part.input, "preparationId");
      let run = typeof id === "string" ? byPreparation.get(id) : undefined;
      // While arguments stream, the correlation id may not have arrived yet.
      if (
        (!id || (typeof id === "string" && id.length < 36)) &&
        part.state === "input-streaming" &&
        /(?:^|_)create_app$/.test(part.toolName)
      ) {
        const latest = runs.at(-1);
        if (
          latest?.preparation &&
          appPreparation(latest.preparation) &&
          latest.builds.length === 0
        )
          run = latest;
      }
      // Without a usable id (unrecorded results), a build belongs to the
      // latest App still being made, not to a new card.
      if (!run && (typeof id !== "string" || !byPreparation.has(id))) {
        const latest = runs.at(-1);
        // Only when the latest preparation's id is unknown (not recorded);
        // a known, different id is a different App.
        if (latest?.preparation && !appPreparation(latest.preparation) && appStepUnrecorded(latest.preparation)
          && !latest.builds.some((build) => builtAppSummary(build) || appStepUnrecorded(build))) run = latest;
      }
      if (run) {
        run.builds.push(part);
        join(run);
      } else {
        const started: AppCreationRun = { id: leadIn[0]?.toolCallId ?? part.toolCallId, builds: [part] };
        join(started);
        runs.push(started);
      }
    } else if (!part.callProviderMetadata?.openwork?.codeMode) {
      // Other work in between: the lookups before it were for something else.
      leadIn = [];
    }
  }
  // A preparation Den rejected, followed by another preparation, is the same
  // App being retried: fold it into the next run instead of a card of its own.
  for (let index = runs.length - 2; index >= 0; index -= 1) {
    const run = runs[index]!;
    const next = runs[index + 1]!;
    const rejected = run.preparation && run.builds.length === 0 && appBuilderResultFailed(run.preparation);
    if (!rejected || !next.preparation || !run.preparation) continue;
    next.attempts = [...(run.discoveries ?? []), run.preparation, ...(run.attempts ?? []), ...(next.attempts ?? [])];
    runs.splice(index, 1);
  }
  for (const run of runs) {
    const calls = [...(run.discoveries ?? []), ...(run.preparation ? [run.preparation] : []), ...(run.attempts ?? []), ...run.builds];
    run.executions = [...parts.values()].filter(part => part.callProviderMetadata?.openwork?.codeMode && calls.some(call => call.toolCallId.startsWith(`${part.toolCallId}:app:`)));
  }
  return runs;
}

export function appCreationProgress(run: AppCreationRun, active: boolean) {
  const preparation = appPreparation(run.preparation);
  const build = run.builds.at(-1);
  const app = build ? builtAppSummary(build) : null;
  const failed = Boolean(
    (build && appBuilderResultFailed(build)) ||
      (!build && run.preparation && appBuilderResultFailed(run.preparation)),
  );
  const checking = build?.state === "input-available";
  // Built, but the launch was not recorded: done, just not previewable here.
  const builtUnrecorded = appStepUnrecorded(build);
  const prepared = Boolean(preparation) || appStepUnrecorded(run.preparation) || builtUnrecorded;
  const stage: AppCreationStage = app || builtUnrecorded
    ? "ready"
    : checking || (build && failed)
      ? "checking"
      : prepared || build
        ? "writing"
        : "needs";
  const title =
    app?.title ??
    field(build?.input, "title") ??
    preparation?.title ??
    field(run.preparation?.input, "title");
  const detail = field(run.preparation?.input, "description");
  // Completion without a verified launch is not success (e.g. catalog capacity).
  const unavailable = Boolean(
    !failed &&
      !builtUnrecorded &&
      ((build?.state === "output-available" && !app) ||
        (!build && run.preparation?.state === "output-available" && !prepared)),
  );
  const running = active && !failed && !unavailable && !app && !builtUnrecorded;
  return {
    stage,
    title: typeof title === "string" ? title : "App",
    prepared,
    detail: typeof detail === "string" ? detail.slice(0, 140) : null,
    preparation,
    build,
    app,
    failed,
    unavailable,
    builtUnrecorded,
    running,
  };
}
