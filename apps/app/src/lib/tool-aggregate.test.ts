import assert from "node:assert/strict"
import { test } from "node:test"
import type { DynamicToolUIPart } from "ai"
import { getAggregateRowFile } from "./tool-aggregate"

for (const errorText of ["Unknown: FileSystem.writeFile (/report.html)", "The user rejected permission to use this specific tool call."]) {
  test(`a failed write does not claim success: ${errorText}`, () => {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "write", toolCallId: "write-report",
      state: "output-error", input: { filePath: "/report.html", content: "hello" }, errorText,
    }
    assert.deepEqual(getAggregateRowFile(part), { verb: "Write failed:", path: "/report.html" })
  })
}

test("an explicitly denied write does not claim success", () => {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "write", toolCallId: "write-report", state: "output-denied",
    input: { filePath: "/report.html", content: "hello" }, approval: { id: "write-approval", approved: false },
  }
  assert.deepEqual(getAggregateRowFile(part), { verb: "Write failed:", path: "/report.html" })
})

test("a successful write says Wrote and an unfinished write says Writing", () => {
  const input = { filePath: "/project/report.html", content: "hello" }
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "write", toolCallId: "write-report",
    state: "output-available", input, output: "Wrote file successfully.",
  }
  assert.equal(getAggregateRowFile(part)?.verb, "Wrote")
  for (const state of ["input-available", "input-streaming"] satisfies DynamicToolUIPart["state"][]) {
    const pending: DynamicToolUIPart = { type: "dynamic-tool", toolName: "write", toolCallId: "write-report", state, input }
    assert.equal(getAggregateRowFile(pending)?.verb, "Writing")
  }
})

test("a write without a known path does not invent a file row", () => {
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "write", toolCallId: "write-report", state: "output-error", input: {}, errorText: "Invalid arguments" }
  assert.equal(getAggregateRowFile(part), null)
})
