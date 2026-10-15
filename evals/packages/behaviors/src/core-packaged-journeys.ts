// Named observations shared by the packaged and desktop-update core journeys
// (PACKAGED-LAUNCH, DESKTOP-UPDATE). They read only what the running app shows
// or what a real client gets back from its HTTP API.

/**
 * Re-read a value for the whole window and fail on the first read that breaks
 * `ok`. Unlike a fixed sleep, every read inside the window is an observation:
 * a fault that appears and disappears mid-window still fails the journey.
 * Returns the last read, taken at or after the end of the window.
 */
export async function holdsFor<T>(
  read: () => Promise<T> | T,
  ok: (value: T) => boolean,
  options: { forMs: number; label: string; intervalMs?: number },
): Promise<T> {
  const intervalMs = options.intervalMs ?? 250;
  const until = Date.now() + options.forMs;
  while (true) {
    const value = await read();
    if (!ok(value)) throw new Error(`${options.label} stopped holding: ${JSON.stringify(value)?.slice(0, 500)}`);
    const remaining = until - Date.now();
    if (remaining <= 0) return value;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}

/** Predicate for `probe.eventually`: a record whose `key` is exactly `expected`. */
export function fieldEquals(key: string, expected: unknown): (value: unknown) => boolean {
  return (value) => typeof value === "object" && value !== null && Reflect.get(value, key) === expected;
}

type DesktopApiResponse = { status: number; body: unknown };

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an engine record");
  return Object.fromEntries(Object.entries(value));
}

export interface EngineTaskMessage {
  id: unknown;
  role: unknown;
  parts: Record<string, unknown>[];
}

/**
 * Reads task history and run status the way the desktop client does: through
 * the workspace's engine mount on the desktop server (v1 `/opencode`, v2
 * `/opencode2/api`).
 */
export function engineTaskReader(
  desktopApi: (path: string) => Promise<DesktopApiResponse>,
  workspaceId: string,
  engine: "v1" | "v2" | string,
) {
  const v2 = engine === "v2";
  const mount = `/workspace/${encodeURIComponent(workspaceId)}/${v2 ? "opencode2/api" : "opencode"}`;
  const read = async (path: string): Promise<unknown> => {
    const response = await desktopApi(`${mount}${path}`);
    if (response.status !== 200) throw new Error(`GET ${mount}${path} returned HTTP ${response.status}`);
    return v2 ? asRecord(response.body).data : response.body;
  };
  return {
    async messages(sessionId: string): Promise<EngineTaskMessage[]> {
      const value = await read(`/session/${sessionId}/${v2 ? "context" : "message?limit=100"}`);
      if (!Array.isArray(value)) throw new Error("Expected engine messages");
      return value.map((entry: unknown) => {
        const message = asRecord(entry);
        const info = v2 ? message : asRecord(message.info);
        const parts = v2 ? message.content : message.parts;
        if (!Array.isArray(parts)) throw new Error("Expected message parts");
        return { id: info.id, role: info[v2 ? "type" : "role"], parts: parts.map(asRecord) };
      });
    },
    async active(sessionId: string): Promise<boolean> {
      const statuses = asRecord(await read(v2 ? "/session/active" : "/session/status"));
      const status = statuses[sessionId];
      return status !== undefined && ["running", "busy", "retry"].includes(String(asRecord(status).type));
    },
  };
}
