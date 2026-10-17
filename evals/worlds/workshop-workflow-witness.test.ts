import test from "node:test";
import assert from "node:assert/strict";
import { workflowComparisonSemantics, WORKSHOP_WORKFLOW_INPUTS } from "./workshop-workflow-witness.ts";
import { artifactDigest } from "../../ee/apps/den-api/src/workflow-artifacts.ts";
const pages = [{ id: "product-a" }, { id: "product-b" }];
const base = "Atlas 2: 300 kg [product-a]. Atlas Lift: 1,200 kg [product-b].";
for (const [name, kind, result, expected] of [
  ["picking is grounded", "test", `${base} Goods-to-person warehouse picking.`, true],
  ["request echo alone", "test", WORKSHOP_WORKFLOW_INPUTS.test.customerRequest, false],
  ["cold storage needs actual operating limit", "rerun", `${base} Cold-storage pallet moves with optional kit.`, false],
  ["cold storage needs optional-kit qualification", "rerun", `${base} Cold-storage pallet moves to -25 °C.`, false],
  ["complete cold storage comparison", "rerun", `${base} Cold-storage pallet moves to -25 °C with optional kit.`, true],
  ["recipient scenario differs from picking", "recipient", `${base} Warehouse picking.`, false],
  ["line-side recipient result", "recipient", `${base} Line-side replenishment.`, true],
  ["invented product facts", "test", "Atlas 2: 999 kg [product-a]. Atlas Lift: 1,200 kg [product-b]. Warehouse picking.", false],
  ["source citations required", "test", "Atlas 2: 300 kg. Atlas Lift: 1,200 kg. Warehouse picking.", false],
] satisfies [string, "test" | "rerun" | "recipient", string, boolean][]) test(name, () => {
  assert.equal(workflowComparisonSemantics(result, kind, pages), expected);
});
test("exact input equality uses the native canonical digest, not arbitrary distinct digest strings", () => {
  assert.equal(artifactDigest(WORKSHOP_WORKFLOW_INPUTS.test), "sha256:76c0d68f239735b7d7b4779eff65431bcf23f1e1ae963ad914cf19ffae30cde3");
  assert.notEqual(artifactDigest({ customerRequest: WORKSHOP_WORKFLOW_INPUTS.test.customerRequest, extra: true }), artifactDigest(WORKSHOP_WORKFLOW_INPUTS.test));
  assert.notEqual(artifactDigest({ customerRequest: WORKSHOP_WORKFLOW_INPUTS.test.customerRequest + " " }), artifactDigest(WORKSHOP_WORKFLOW_INPUTS.test));
});
