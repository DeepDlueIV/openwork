import assert from "node:assert/strict"
import { test } from "node:test"
import { DocumentsError } from "../src/index"
import { documentsAccessFailure, DOCUMENT_RECOVERY_MS } from "../src/access"

test("listing availability, connection recovery, revocation and feature state are separate facts", () => {
  assert.equal(documentsAccessFailure(new Error("offline")), null)
  assert.equal(documentsAccessFailure(new DocumentsError(503, "upstream_unavailable", "")), null)
  assert.equal(documentsAccessFailure(new DocumentsError(409, "needs_connection", "")), "connection")
  assert.equal(documentsAccessFailure(new DocumentsError(401, "unauthorized", "")), "connection")
  assert.equal(documentsAccessFailure(new DocumentsError(403, "permission_denied", "")), "blocked")
  assert.equal(documentsAccessFailure(new DocumentsError(409, "unknown_conflict", "")), "blocked")
  assert.equal(documentsAccessFailure(new DocumentsError(403, "feature_disabled", "")), "disabled")
  assert.equal(DOCUMENT_RECOVERY_MS, 15 * 60 * 1000)
})
