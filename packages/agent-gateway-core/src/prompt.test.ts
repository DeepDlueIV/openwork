import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import { PromptError, confirm, isInteractive, pick } from "./prompt.ts"

const streams = { input: new PassThrough(), output: new PassThrough() }

test("without a TTY, prompts return their default or explain what to pass", async () => {
  assert.equal(isInteractive(streams), false)
  assert.equal(await confirm("Continue?", { ...streams, defaultValue: true }), true)
  await assert.rejects(confirm("Continue?", { ...streams, hint: "pass --yes" }), (error: unknown) => {
    assert.ok(error instanceof PromptError)
    assert.match(error.message, /pass --yes/)
    return true
  })
  const choices = [{ label: "A", value: "a" }, { label: "B", value: "b" }]
  assert.equal(await pick("Model?", choices, { ...streams, defaultIndex: 1 }), "b")
  assert.equal(await pick("Model?", [{ label: "Only", value: "only" }], streams), "only")
  await assert.rejects(pick("Model?", choices, { ...streams, hint: "pass --model" }), /pass --model/)
  await assert.rejects(pick("Model?", [], streams), PromptError)
})
