import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { readWorkbotModel } from "@openwork/types/den/workbot-settings"
import { db } from "../db.js"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps, type HeadlessModelCatalog } from "../headless-runner/client.js"
import { explicitWorkbotModel, workbotDefaultReadiness } from "./readiness.js"

/**
 * The organization's default model for its cloud agents on the headless runner: Workbot, the Slack assistant, and
 * cloud Automations set to the cloud default. Admins choose it in Den › Manage › Workbot.
 *
 * It is a default, not a lock: an Automation with its own model keeps it. Null means the runner's default. A saved
 * model the runner no longer serves also gives null, so a removed model never breaks every chat.
 * One organization-wide value; per-team overrides could later be resolved on top of it here.
 */
export type OrganizationModelPolicy = {
  /** Callers use `model`; false is reserved for an unavailable policy read. */
  enabled: boolean
  /** The model to send to the runner; null means the runner's default. Always null when not enabled. */
  model: string | null
}

const CATALOG_CACHE_MS = 60_000
let cachedCatalog: { at: number; value: Promise<HeadlessModelCatalog | null> } | null = null

/** The runner's model catalog, shared for a minute: every chat turn, Slack run and Automation run reads it. */
export function headlessModelCatalog(now = Date.now()): Promise<HeadlessModelCatalog | null> {
  if (cachedCatalog && now - cachedCatalog.at < CATALOG_CACHE_MS) return cachedCatalog.value
  const deps = defaultHeadlessRunnerDeps()
  const value = deps ? createHeadlessRunnerClient(deps).listModels().catch(() => null) : Promise.resolve(null)
  cachedCatalog = { at: now, value }
  // A failed read is not kept: the next caller asks again.
  void value.then((catalog) => {
    if (!catalog && cachedCatalog?.value === value) cachedCatalog = null
  })
  return value
}

/** Forget the cached catalog, so the admin page and the next turn see a change at once. */
export function forgetHeadlessModelCatalog() {
  cachedCatalog = null
}

/** The organization's saved choice, read fresh so an admin's change applies to the next turn. */
export async function readOrganizationDefaultModel(organizationId: string): Promise<string | null> {
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
    .limit(1)
  return readWorkbotModel(organization?.metadata)
}

/** The chosen model when the runner serves it (or can't say right now), otherwise null: the runner's default. */
export function servableModel(chosen: string | null, catalog: HeadlessModelCatalog | null): string | null {
  if (!chosen) return null
  if (!catalog) return chosen
  return catalog.models.some((entry) => entry.id === chosen) ? chosen : null
}

/** What the admin page shows: the saved model, whether the runner still serves it, and what can be chosen. */
export function workbotSettingsView(chosen: string | null, catalog: HeadlessModelCatalog | null) {
  return {
    model: chosen,
    defaultModel: explicitWorkbotModel(null, catalog),
    defaultReadiness: workbotDefaultReadiness(catalog),
    models: catalog?.models ?? [],
    modelAvailable: chosen === null || catalog === null || catalog.models.some((entry) => entry.id === chosen),
    runnerReachable: catalog !== null,
  }
}

/** A model may be saved only when the runner serves it right now; null (the runner's default) always may. */
export function checkWorkbotModelChoice(model: string | null, catalog: HeadlessModelCatalog | null): "ok" | "unknown_model" | "runner_unavailable" {
  if (model === null) return "ok"
  if (!catalog || catalog.verified !== true) return "runner_unavailable"
  return catalog.models.some((entry) => entry.id === model) ? "ok" : "unknown_model"
}

export type OrganizationModelPolicyDeps = {
  chosenModel: (organizationId: string) => Promise<string | null>
  catalog: () => Promise<HeadlessModelCatalog | null>
}

const defaultDeps: OrganizationModelPolicyDeps = {
  chosenModel: readOrganizationDefaultModel,
  catalog: () => headlessModelCatalog(),
}

export async function organizationModelPolicy(
  organizationId: string,
  deps: Partial<OrganizationModelPolicyDeps> = {},
): Promise<OrganizationModelPolicy> {
  const { chosenModel, catalog } = { ...defaultDeps, ...deps }
  const chosen = await chosenModel(organizationId)
  return { enabled: true, model: chosen ? servableModel(chosen, await catalog()) : null }
}

/** The model the organization's cloud agents answer with, or null for the runner's default. */
export async function organizationDefaultModel(
  organizationId: string,
  deps: Partial<OrganizationModelPolicyDeps> = {},
): Promise<string | null> {
  return (await organizationModelPolicy(organizationId, deps)).model
}

/**
 * The model a headless Slack run sends: the organization default for every organization; the model saved
 * on the Slack installation is only an outage fallback. Undefined means the runner's default. A failed read keeps Slack answering.
 */
export async function slackAssistantModel(
  installation: { organizationId: string; model: string | null },
  deps: Partial<OrganizationModelPolicyDeps> = {},
): Promise<string | undefined> {
  const policy = await organizationModelPolicy(installation.organizationId, deps).catch((): OrganizationModelPolicy => ({ enabled: false, model: null }))
  if (policy.enabled) return policy.model ?? undefined
  return installation.model ?? undefined
}
