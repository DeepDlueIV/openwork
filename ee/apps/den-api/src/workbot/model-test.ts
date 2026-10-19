import { WORKBOT_DEFAULT_MODEL_ID, type WorkbotModelTest } from "@openwork/types/den/workbot-settings"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps } from "../headless-runner/client.js"
import { cloudAgentGatewayEnabled, cloudAgentModelCatalog, forgetHeadlessModelCatalog, headlessModelCatalog, readOrganizationDefaultModel } from "./model.js"
import { cloudAgentGatewayAccess } from "./gateway-model.js"
import { explicitWorkbotModel } from "./readiness.js"

/** Called only after user-session, feature, sensitive permission and durable diagnostic-rate checks. */
export async function testOrganizationWorkbotModel(organizationId: string, userId: string): Promise<WorkbotModelTest> {
  const actor = { organizationId, userId }
  const gatewayModels = await cloudAgentGatewayEnabled(organizationId)
  forgetHeadlessModelCatalog()
  const catalog = await (gatewayModels ? cloudAgentModelCatalog(actor) : headlessModelCatalog()).catch(() => null)
  const chosen = await readOrganizationDefaultModel(organizationId)
  const requestedModel = gatewayModels ? chosen ?? catalog?.defaultModel ?? WORKBOT_DEFAULT_MODEL_ID : explicitWorkbotModel(chosen, catalog)
  const failed = (errorCode: "model_unavailable" | "runner_unavailable"): WorkbotModelTest => ({ status: "failed", errorCode, requestedModel, reportedModel: null })
  if (catalog?.verified !== true || !catalog.models.some((model) => model.id === requestedModel)) return failed("model_unavailable")
  const deps = defaultHeadlessRunnerDeps()
  if (!deps) return failed("runner_unavailable")
  const modelAccess = gatewayModels ? await cloudAgentGatewayAccess(actor, requestedModel).catch(() => null) : undefined
  if (modelAccess === null) return failed("model_unavailable")
  return await createHeadlessRunnerClient(deps).testModel(requestedModel, modelAccess).catch(() => null) ?? failed("runner_unavailable")
}
