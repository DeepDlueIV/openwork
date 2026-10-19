import type { WorkbotModelTest } from "@openwork/types/den/workbot-settings"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps } from "../headless-runner/client.js"
import { forgetHeadlessModelCatalog, headlessModelCatalog, readOrganizationDefaultModel } from "./model.js"
import { explicitWorkbotModel } from "./readiness.js"

/** Called only after user-session, feature, sensitive permission and durable diagnostic-rate checks. */
export async function testOrganizationWorkbotModel(organizationId: string): Promise<WorkbotModelTest> {
  forgetHeadlessModelCatalog()
  const catalog = await headlessModelCatalog()
  const requestedModel = explicitWorkbotModel(await readOrganizationDefaultModel(organizationId), catalog)
  const failed = (errorCode: "model_unavailable" | "runner_unavailable"): WorkbotModelTest => ({ status: "failed", errorCode, requestedModel, reportedModel: null })
  if (catalog?.verified !== true || !catalog.models.some((model) => model.id === requestedModel)) return failed("model_unavailable")
  const deps = defaultHeadlessRunnerDeps()
  if (!deps) return failed("runner_unavailable")
  return await createHeadlessRunnerClient(deps).testModel(requestedModel).catch(() => null) ?? failed("runner_unavailable")
}
