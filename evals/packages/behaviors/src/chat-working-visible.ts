// Rendered-UI reads for the CHAT-WORKING-VISIBLE core journey.

interface DomReader {
  dom(selector: string): Promise<{ elements: { text: string; rect: { height: number } }[] }>;
}

export interface ChatWorkingScreen {
  /** The turn's own "Working 12s" line, or null when no turn-level Working line shows. */
  working: string | null;
  /** Height of the live steps area, or null when it is not rendered. */
  liveHeight: number | null;
  /** Whether a helper (sub-agent) row is on screen. */
  helperRow: boolean;
}

const WORKING = /Working\s*\d+(?:m\s*\d+)?s/;

/**
 * What a person glancing at the chat sees: the turn's Working line, the live
 * steps height and whether a helper row shows. A helper row carries its own
 * timer, which is not the turn's, so helper text is removed before looking.
 */
export async function chatReadWorkingScreen(probe: DomReader): Promise<ChatWorkingScreen> {
  const [candidates, helpers, live] = await Promise.all([
    probe.dom("[data-loading-message], [data-live-steps], [data-message-id]"),
    probe.dom("[data-subagent-run]"),
    probe.dom("[data-live-steps]"),
  ]);
  const helperTexts = helpers.elements.map((element) => element.text).filter(Boolean);
  const working = candidates.elements
    .map((element) => helperTexts.reduce((text, helper) => text.split(helper).join(" "), element.text).match(WORKING)?.[0] ?? null)
    .find((text) => text !== null) ?? null;
  const first = live.elements[0];
  return { working, liveHeight: first ? Math.round(first.rect.height) : null, helperRow: helpers.elements.length > 0 };
}

/** Seconds shown on a "Working 1m 5s" line, or null. */
export function chatWorkingSeconds(working: string | null): number | null {
  const match = working?.match(/(?:(\d+)m\s*)?(\d+)s/);
  return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : null;
}
