import assert from "node:assert/strict";
import { test } from "node:test";
import { linkedWorkbotOrganization } from "./workbot-team-link";

const orgs = [{ id: "org_first" }, { id: "org_second" }];
test("a Workbot settings or connections link pins the chosen member workspace", () => {
  for (const page of ["workbot-settings", "mcp-connections"]) {
    assert.equal(linkedWorkbotOrganization(`https://den.example.test/dashboard/${page}?workbotOrganizationId=org_second`, orgs), "org_second");
  }
  assert.equal(linkedWorkbotOrganization("https://den.example.test/dashboard/workbot-settings", orgs), null);
});
test("unavailable, empty and unrelated Workbot links fail closed instead of choosing the active workspace", () => {
  for (const href of [
    "https://den.example.test/dashboard/workbot-settings?workbotOrganizationId=org_other",
    "https://den.example.test/dashboard/workbot-settings?workbotOrganizationId=",
    "https://den.example.test/dashboard/workbot-settings?workbotOrganizationId=org_first&workbotOrganizationId=org_second",
    "https://den.example.test/dashboard/billing?workbotOrganizationId=org_first",
  ]) assert.throws(() => linkedWorkbotOrganization(href, orgs), /workspace is unavailable/);
});
