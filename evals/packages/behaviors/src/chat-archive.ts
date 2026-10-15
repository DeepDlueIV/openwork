// Archive actions a person or an agent takes, and what they read back, for the SESSION-ARCHIVE core journey.
import type { Target } from "@openwork/cdp";

export interface ArchiveTarget {
  workspaceId: string;
  sessionId: string;
}

interface ArchiveUser {
  hover(target: Target): Promise<void>;
  click(target: Target): Promise<void>;
}

interface ArchiveServerReader {
  /** GET from the desktop's own local server, as any local client of it would. */
  desktopApi(path: string): Promise<{ status: number; body: unknown }>;
}

interface ArchiveAgent {
  desktopApi(path: string, input: { method: string; body?: unknown }): Promise<{ status: number; body: unknown }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The person hovers a conversation's sidebar row and clicks its Archive button. */
export async function archiveFromSidebar(user: ArchiveUser, target: ArchiveTarget) {
  await user.hover({ testId: `sidebar-session-${target.sessionId}` });
  await user.click({ testId: `session-archive-${target.sessionId}` });
}

/** The conversation's archive time as the local server reports it; 0 when it is not archived. */
export async function archiveReadArchivedAt(probe: ArchiveServerReader, target: ArchiveTarget): Promise<number> {
  const response = await probe.desktopApi(`/workspace/${encodeURIComponent(target.workspaceId)}/opencode/session/${encodeURIComponent(target.sessionId)}`);
  if (response.status !== 200 || !isRecord(response.body)) throw new Error(`Session read returned HTTP ${response.status}`);
  const time = response.body.time;
  return isRecord(time) && typeof time.archived === "number" ? time.archived : 0;
}

/**
 * An agent in conversation `origin` asks the app to archive `target`, through
 * the same command mailbox the OpenCode plugin uses for agent requests.
 */
export async function archiveAsAgent(agent: ArchiveAgent, origin: ArchiveTarget, target: ArchiveTarget) {
  const startedAt = Date.now();
  const response = await agent.desktopApi("/experimental/ui-control/request", {
    method: "POST",
    body: { kind: "command", input: { id: "session.archive", args: { sessionId: target.sessionId, archived: true }, origin: { sessionId: origin.sessionId } } },
  });
  return { ...response, elapsedMs: Date.now() - startedAt };
}
