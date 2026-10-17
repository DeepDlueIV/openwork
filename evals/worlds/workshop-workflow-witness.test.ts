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
  ["line-side recipient result", "recipient", `${base} Atlas 2 supports documented line-side replenishment.`, true],
  ["invented product facts", "test", "Atlas 2: 999 kg [product-a]. Atlas Lift: 1,200 kg [product-b]. Warehouse picking.", false],
  ["source citations required", "test", "Atlas 2: 300 kg. Atlas Lift: 1,200 kg. Warehouse picking.", false],
] satisfies [string, "test" | "rerun" | "recipient", string, boolean][]) test(name, () => {
  assert.equal(workflowComparisonSemantics(result, kind, pages), expected);
});
test("request echo plus base facts cannot impersonate an input-specific assessment", () => {
  const kinds: ("test" | "rerun" | "recipient")[] = ["test", "rerun", "recipient"];
  for (const kind of kinds) {
    const output = { customerRequest: WORKSHOP_WORKFLOW_INPUTS[kind].customerRequest, comparison: base, operatingLimit: "-25 °C optional kit" };
    assert.equal(workflowComparisonSemantics(output, kind, pages), false, kind);
  }
});
test("line-side assessment recognizes the documented Atlas 2 use case instead of denying any documented match", () => {
  const actualShape = { customerRequest: WORKSHOP_WORKFLOW_INPUTS.recipient.customerRequest, comparison: base, focus: "clarification needed", recommendation: "No documented match established; obtain additional requirements and evidence." };
  assert.equal(workflowComparisonSemantics(actualShape, "recipient", pages), false);
  assert.equal(workflowComparisonSemantics({ ...actualShape, comparison: `${base} Atlas 2 supports documented line-side replenishment.`, focus: "line-side replenishment", recommendation: "Atlas 2 is a documented use-case candidate; confirm payload and layout before deployment." }, "recipient", pages), true);
  assert.equal(workflowComparisonSemantics({ ...actualShape, comparison: `${base} Atlas 2 supports documented line-side replenishment.` }, "recipient", pages), false, "A copied use-case sentence cannot excuse a contradictory recommendation");
});
test("raw datasheet source bodies cannot replace a computed comparison", () => {
  assert.equal(workflowComparisonSemantics({ customerRequest: WORKSHOP_WORKFLOW_INPUTS.recipient.customerRequest, sources: [{ body: `${base} Atlas 2 line-side replenishment.` }], comparison: "No documented match established." }, "recipient", pages), false);
});

test("exact input equality uses the native canonical digest, not arbitrary distinct digest strings", () => {
  assert.equal(artifactDigest(WORKSHOP_WORKFLOW_INPUTS.test), "sha256:76c0d68f239735b7d7b4779eff65431bcf23f1e1ae963ad914cf19ffae30cde3");
  assert.notEqual(artifactDigest({ customerRequest: WORKSHOP_WORKFLOW_INPUTS.test.customerRequest, extra: true }), artifactDigest(WORKSHOP_WORKFLOW_INPUTS.test));
  assert.notEqual(artifactDigest({ customerRequest: WORKSHOP_WORKFLOW_INPUTS.test.customerRequest + " " }), artifactDigest(WORKSHOP_WORKFLOW_INPUTS.test));
});
