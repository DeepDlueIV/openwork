// Steps shared by the Apps, Automations, first-run and recovery core journeys
// (evals/core). They act as a person does or read rendered UI and public Den
// APIs; no internal state is read here.
import type { Probe, User } from "@openwork/testkit";
import { denFetch, type DenSession } from "./den.ts";
import type { ResponseFacts } from "./workflows.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function send(session: DenSession, path: string, method: string, body?: unknown): Promise<ResponseFacts> {
  const { response, body: parsed, text } = await denFetch(session, path, {
    method,
    headers: { authorization: `Bearer ${session.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: parsed, text };
}

// ── Automations ─────────────────────────────────────────────────────────────

/** The id of the organization this person is signed in to, as Den's org switcher reads it. */
export async function activeOrganizationId(session: DenSession): Promise<string> {
  const result = await send(session, "/v1/me/orgs", "GET");
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const id = isRecord(result.body) && typeof result.body.activeOrgId === "string" ? result.body.activeOrgId : orgs[0]?.id;
  if (typeof id !== "string" || !id) throw new Error(`Den lists no organization for ${session.email}: HTTP ${result.status}`);
  return id;
}

/** Pause (`active: false`) or resume an Automation, as the Automations page and Calendar do. */
export function setAutomationActive(session: DenSession, automationId: string, active: boolean): Promise<ResponseFacts> {
  return send(session, `/v1/automations/${encodeURIComponent(automationId)}/${active ? "activate" : "deactivate"}`, "POST", {});
}

/** Test an edited Workflow draft; Den returns a receipt that only the exact tested draft may be saved with. */
export function testWorkflowDraft(session: DenSession, draft: Record<string, unknown>): Promise<ResponseFacts> {
  return send(session, "/v1/workflows/test", "POST", draft);
}

/** Save a new immutable version of a Workflow from a tested draft. */
export function saveWorkflowVersion(session: DenSession, configObjectId: string, draft: Record<string, unknown>): Promise<ResponseFacts> {
  return send(session, `/v1/workflows/${encodeURIComponent(configObjectId)}/versions`, "POST", draft);
}

// ── Apps ────────────────────────────────────────────────────────────────────

const personalTiles = '[data-dashboard-tile^="personal:"]';

/** Waits until exactly one App creation step in the chat shows this stage, and returns how many do. */
export async function waitForAppCreationStage(probe: Probe, stage: "needs" | "writing" | "ready"): Promise<number> {
  const steps = await probe.eventually(async () => (await probe.dom(`[data-app-builder-step][data-app-creation-stage="${stage}"]`)).elements, {
    within: 30_000, intervalMs: 200, label: `one App creation step reads ${stage}`, until: elements => elements.length === 1,
  });
  return steps.length;
}

/**
 * Waits until the personal dashboard shows `count` tiles and returns how many it shows. With
 * `settled`, a tile counts only once it has replaced its saved copy with the live App.
 */
export async function waitForDashboardTiles(probe: Probe, count: number, options: { settled?: boolean } = {}): Promise<number> {
  const selector = options.settled ? `${personalTiles}[aria-busy="false"]` : personalTiles;
  const tiles = await probe.eventually(async () => (await probe.dom(selector)).elements, {
    within: 90_000, intervalMs: 200, label: `${count} personal dashboard tile(s)${options.settled ? " showing the live App" : ""}`,
    until: elements => elements.length === count,
  });
  return tiles.length;
}

/** Compact dashboard tiles show their menu only while hovered, so point at the App inside the tile, then open its menu. */
export async function openArtifactOptions(user: User, probe: Probe, viewer: DenSession, title: string): Promise<void> {
  const listed = await probe.api(viewer, "/v1/mcp-apps");
  const body: unknown = listed.body;
  const apps = typeof body === "object" && body !== null && Array.isArray(Reflect.get(body, "apps")) ? Reflect.get(body, "apps") : [];
  const app: unknown = Array.isArray(apps) ? apps.find((entry: unknown) => typeof entry === "object" && entry !== null && Reflect.get(entry, "title") === title) : undefined;
  const resourceUri = typeof app === "object" && app !== null ? String(Reflect.get(app, "resourceUri") ?? "") : "";
  if (!resourceUri) throw new Error(`Den's App catalog does not list ${title}: HTTP ${listed.response.status}`);
  await user.hover({ mcpApp: { resourceUri }, role: "heading", label: title });
  await user.click({ role: "button", label: `Artifact options for ${title}` });
}
