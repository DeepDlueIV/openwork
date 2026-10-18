import assert from "node:assert/strict"
import { test } from "node:test"
import { isWorkbotSignIn, workbotFirstRunEnabled } from "../../den-web/app/mcp/use-workbot-first-run.js"
import { getMcpOAuthSelectOrganizationRoute, getMcpOAuthSocialCallbackUrl } from "../../den-web/app/(den)/_lib/mcp-oauth-route.js"

test("compact first-party presentation needs Workbot's exact client and an enabled registry rollout", () => {
  assert.equal(isWorkbotSignIn("client_id=openwork-workbot&response_type=code"), true)
  assert.equal(isWorkbotSignIn("client_id=other&client_name=Workbot&response_type=code"), false)
  assert.equal(isWorkbotSignIn("client_id=openwork-workbot&response_type=token"), false)
  for (const payload of [null, {}, { features: {} }, { features: { workbotFirstRun: "true" } }, { features: { workbotFirstRun: false } }]) {
    assert.equal(workbotFirstRunEnabled(payload), false)
  }
  assert.equal(workbotFirstRunEnabled({ features: { workbotFirstRun: true } }), true)
})

test("email and social sign-in keep the exact signed Workbot query instead of a dashboard destination", () => {
  const query = "client_id=openwork-workbot&response_type=code&scope=openid+email+mcp%3Aread&state=state%2Bvalue&code_challenge=challenge&code_challenge_method=S256&exp=123&sig=signed%2Bquery"
  assert.equal(getMcpOAuthSelectOrganizationRoute(`?${query}`), `/mcp/select-organization?${query}`)
  assert.equal(getMcpOAuthSocialCallbackUrl(`?${query}`, "https://workspace.example.test"), `https://workspace.example.test/?${query}`)
})
