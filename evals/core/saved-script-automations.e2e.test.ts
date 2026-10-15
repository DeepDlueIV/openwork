import { expect } from "vitest"
import {
  activeOrganizationId,
  callMcpTool,
  createCloudAutomation,
  createOrgConnection,
  grantOpenWorkWebAccess,
  listWorkflows,
  mintMcpToken,
  patchAutomation,
  readAutomation,
  readAutomationRun,
  readAutomationRuns,
  runAutomationNow,
  runWorkflow,
  saveWorkflow,
  saveWorkflowVersion,
  setAutomationActive,
  testWorkflowDraft,
} from "@openwork/behaviors"
import { needs, spec } from "@openwork/testkit"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function at(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value)
}

function text(value: unknown, ...path: string[]): string {
  const found = at(value, ...path)
  return typeof found === "string" ? found : ""
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

const test = spec.world(async seed => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_SAVED_SCRIPT_AUTOMATIONS_E2E_TEST"] })
  const den = await seed.den({
    env: { DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: "true" },
    org: { name: `Workflow Automation ${Date.now()}`, admin: { name: "Sarah" } },
    mocks: { reports: seed.mock({ allowUnauthenticatedMcp: true }) },
  })
  return { den }
}, { timeout: 1_200_000, resources: { surfaces: [], services: ["den", "mock"] } })

test("an owner saves a Workflow, its Automation runs unattended on schedule, and they can pause it or return to an earlier version", async ({ world, probe, step }) => {
  const { den } = world
  const owner = den.admin
  const stamp = Date.now()
  const name = `Launch briefing ${stamp}`
  const inputSchema = { type: "object", properties: { topic: { type: "string" } }, required: ["topic"], additionalProperties: false }
  const outputSchema = { type: "object", properties: { briefing: {} }, required: ["briefing"], additionalProperties: false }
  const code = "const result = await tools.den.getWorkers({})\nreturn { briefing: { topic: input.topic, workerCount: result.workers.length } }"
  const organizationId = await activeOrganizationId(owner)
  // Cloud Automations need OpenWork Web access; the launched Den allowlists this admin to grant it.
  await grantOpenWorkWebAccess(owner, organizationId, "saved-script-automations spec exercises Cloud Automations")
  const mcpToken = await mintMcpToken(owner)
  const finished = (run: unknown) => ["succeeded", "failed", "skipped", "cancelled"].includes(text(run, "status"))
  const script = { pluginId: "", configObjectId: "", configObjectVersionId: "" }

  await step("an ad-hoc Code Mode result is saved as a Workflow without retyping it, and runs on demand", async () => {
    const marker = `launch-now-${stamp}`
    const executed = await callMcpTool(den.ref, mcpToken, "execute_capability_script", { code, input: { topic: marker } })
    expect(executed.isError).toBe(false)
    expect(executed.raw).toContain(marker)
    const saved = await saveWorkflow(owner, { name, code, currentInput: { topic: marker }, inputSchema, outputSchema })
    expect(saved.status, saved.text).toBe(201)
    Object.assign(script, { pluginId: text(saved.body, "pluginId"), configObjectId: text(saved.body, "configObjectId"), configObjectVersionId: text(saved.body, "configObjectVersionId") })
    expect(Object.values(script).every(Boolean)).toBe(true)
    const run = await runWorkflow(owner, script.configObjectId, { ...script, input: { topic: marker } })
    expect(run.status).toBe("succeeded")
    expect(JSON.stringify(run.value)).toContain(marker)
  })

  let automationId = ""
  const scheduledMarker = `launch-scheduled-${stamp}`
  await step("a once-scheduled Cloud Automation runs the Workflow unattended at its time", async () => {
    const created = await createCloudAutomation(owner, {
      name: `${name} once`,
      schedule: { kind: "once", timezone: "UTC", at: Date.now() + 30_000 },
      action: { kind: "saved_script", script, input: { topic: scheduledMarker } },
    })
    expect(created.status, created.text).toBe(201)
    automationId = text(created.body, "automation", "id")
    expect(automationId).not.toBe("")
    const scheduled = await probe.eventually(async () => records(at((await readAutomationRuns(owner, automationId)).body, "items")).find(run => run.trigger === "scheduled"), {
      within: 5 * 60_000, intervalMs: 2_000, label: "the scheduled Workflow Automation run succeeds", until: run => run?.status === "succeeded",
    })
    const receipt = (await readAutomationRun(owner, text(scheduled, "id"))).body
    expect(JSON.stringify(receipt)).toContain(scheduledMarker)
    expect(at(receipt, "automation", "id")).toBe(automationId)
    expect(at(receipt, "run", "executionThread")).toMatchObject({ threadKind: "automation", executionLocation: "cloud", automationId, automationRunId: text(scheduled, "id") })
  })

  await step("an MCP client reads the latest scheduled result as a standard MCP App", async () => {
    const rendered = await callMcpTool(den.ref, mcpToken, "render_workflow_artifact", { configObjectId: script.configObjectId })
    expect(rendered.isError).toBe(false)
    expect(at(rendered.structured, "artifact")).toMatchObject({ configObjectId: script.configObjectId, source: "scheduled" })
    expect(JSON.stringify(at(rendered.structured, "data"))).toContain(scheduledMarker)
    expect(rendered.text).toContain(scheduledMarker)
  })

  const externalMarker = `launch-external-${stamp}`
  const external = { pluginId: "", configObjectId: "", configObjectVersionId: "" }
  await step("a Workflow using a connection added after the first 16 is found, run, saved, and edited only from a matching test", async () => {
    for (let index = 0; index < 16; index += 1) {
      await createOrgConnection(owner, { name: `Earlier source ${index}`, url: den.mocks.reports.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } })
    }
    const connection = await createOrgConnection(owner, { name: "Report source", url: den.mocks.reports.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } })
    const search = await callMcpTool(den.ref, mcpToken, "search_capabilities", { query: "Report source mock_echo", type: "mcp", limit: 20 })
    const match = records(at(search.body, "matches")).find(entry => entry.name === `mcp:${connection.id}:mock_echo`)
    expect(match?.scriptPath).toBe("tools.report_source.mock_echo")
    const externalCode = `await tools.report_source.mock_batch({ items: [{ text: input.topic }] }); return { briefing: await tools.report_source.mock_echo({ text: input.topic }) }`
    // MCP clients may send `input` JSON-encoded; it is bound as an object either way.
    const startedAt = new Date().toISOString()
    const executed = await callMcpTool(den.ref, mcpToken, "execute_capability_script", { code: externalCode, input: JSON.stringify({ topic: externalMarker }) })
    expect(executed.isError).toBe(false)
    const calls = await den.mocks.reports.toolCalls({ name: "mock_echo", atLeast: 1, sinceIso: startedAt, timeoutMs: 60_000 })
    expect(calls.filter(call => call.args.text === externalMarker)).toHaveLength(1)
    const saved = await saveWorkflow(owner, { name: `${name} external`, code: externalCode, currentInput: { topic: externalMarker }, inputSchema, outputSchema })
    expect(saved.status, saved.text).toBe(201)
    Object.assign(external, { pluginId: text(saved.body, "pluginId"), configObjectId: text(saved.body, "configObjectId") })
    const draft = {
      name: `${name} edited external`, code: externalCode, exampleInput: { topic: externalMarker }, inputSchema, outputSchema,
      requiredCapabilities: ["mock_batch", "mock_echo"].map(tool => ({ capabilityName: `mcp:${connection.id}:${tool}`, scriptPath: `tools.report_source.${tool}` })),
    }
    const tested = await testWorkflowDraft(owner, { ...draft, configObjectId: external.configObjectId })
    expect(tested.status, tested.text).toBe(200)
    const receiptId = text(tested.body, "receiptId")
    const untested = await saveWorkflowVersion(owner, external.configObjectId, { ...draft, code: `${externalCode}\n`, receiptId })
    expect(untested.status, untested.text).toBe(400)
    expect(untested.text).toContain("workflow_matching_test_receipt_required")
    const edited = await saveWorkflowVersion(owner, external.configObjectId, { ...draft, receiptId })
    expect(edited.status, edited.text).toBe(201)
    external.configObjectVersionId = text(edited.body, "currentVersion", "id")
    expect(external.configObjectVersionId).not.toBe("")
  })

  await step("a Workflow that depends on in-script search is refused with a next step and is not saved", async () => {
    const searchCode = "const found = await tools.$codemode.search({ query: input.topic }); return { count: found.items.length }"
    const rejected = await saveWorkflow(owner, { name: `${name} search`, code: searchCode, currentInput: { topic: "workers" }, inputSchema })
    expect(rejected.status, rejected.text).toBe(400)
    expect(rejected.body).toMatchObject({ error: "workflow_capability_unavailable", capability: expect.stringMatching(/\$codemode\.search$/), message: expect.stringContaining("search_capabilities") })
    expect((await listWorkflows(owner)).items.some(item => item.name === `${name} search`)).toBe(false)
  })

  await step("after: the Automation, pointed at the edited Workflow, runs unattended and calls the external tools", async () => {
    const patched = await patchAutomation(owner, automationId, { action: { kind: "saved_script", script: external, input: { topic: externalMarker } } })
    expect(patched.status, patched.text).toBe(200)
    const startedAt = new Date().toISOString()
    const queued = await runAutomationNow(owner, automationId)
    expect(queued.status, queued.text).toBe(202)
    const runId = text(queued.body, "run", "id")
    const receipt = await probe.eventually(async () => (await readAutomationRun(owner, runId)).body, {
      within: 180_000, intervalMs: 2_000, label: "the unattended external Workflow run finishes", until: body => finished(at(body, "run")),
    })
    expect(at(receipt, "run", "status"), JSON.stringify(at(receipt, "run", "error") ?? null)).toBe("succeeded")
    const calls = await den.mocks.reports.toolCalls({ sinceIso: startedAt })
    expect(calls.map(call => call.name)).toEqual(["mock_batch", "mock_echo"])
    expect(calls.some(call => call.args.text === externalMarker)).toBe(true)
  })

  let dailyId = ""
  await step("pausing a daily Automation clears its next run, and resuming schedules it again", async () => {
    const created = await createCloudAutomation(owner, {
      name: `${name} daily`, schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
      action: { kind: "saved_script", script, input: { topic: `launch-daily-${stamp}` } },
    })
    expect(created.status, created.text).toBe(201)
    dailyId = text(created.body, "automation", "id")
    expect(at(created.body, "automation", "state")).toBe("active")
    expect(at(created.body, "automation", "nextDueAt")).toBeGreaterThan(Date.now())
    const paused = await setAutomationActive(owner, dailyId, false)
    expect(paused.status, paused.text).toBe(200)
    expect(at(paused.body, "automation")).toMatchObject({ state: "inactive", nextDueAt: null })
    const resumed = await setAutomationActive(owner, dailyId, true)
    expect(resumed.status, resumed.text).toBe(200)
    expect(at(resumed.body, "automation", "state")).toBe("active")
    expect(at(resumed.body, "automation", "nextDueAt")).toBeGreaterThan(Date.now())
  })

  await step("returning to the earlier definition restores its behavior as a new revision", async () => {
    const before = await readAutomation(owner, dailyId)
    const original = at(before.body, "revision")
    const changed = await patchAutomation(owner, dailyId, { action: { kind: "saved_script", script: external, input: { topic: externalMarker } } })
    expect(changed.status, changed.text).toBe(200)
    expect(at(changed.body, "revision", "digest")).not.toBe(at(original, "digest"))
    const reverted = await patchAutomation(owner, dailyId, { action: { kind: "saved_script", script, input: { topic: `launch-daily-${stamp}` } } })
    expect(reverted.status, reverted.text).toBe(200)
    expect(at(reverted.body, "revision", "digest")).toBe(at(original, "digest"))
    expect(at(reverted.body, "revision", "id")).not.toBe(at(original, "id"))
    expect(at(reverted.body, "revision", "id")).not.toBe(at(changed.body, "revision", "id"))
    expect(Number(at(reverted.body, "revision", "version"))).toBe(Number(at(original, "version")) + 2)
  })
})
