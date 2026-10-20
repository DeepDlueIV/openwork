import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServicesAccessScreen } from "./services-access-screen";

function render(status: Parameters<typeof ServicesAccessScreen>[0]["status"]) {
  return renderToStaticMarkup(createElement(ServicesAccessScreen, { status, onRetry: () => undefined }));
}

test("signed-out and ordinary members see distinct authorization states with no diagnostics or rollout links", () => {
  assert.match(render("signed-out"), /Sign in required/);
  assert.match(render("forbidden"), /Admin access required/);
  for (const status of ["signed-out", "forbidden"] satisfies Parameters<typeof ServicesAccessScreen>[0]["status"][]) {
    assert.doesNotMatch(render(status), /service-status-|Missing setting|\/admin\/features|service-check-now/);
  }
});

test("a feature-off administrator sees the lock reason and rollout recovery, not a permission denial", () => {
  const output = render("locked");
  assert.match(output, /admin-services-locked/);
  assert.match(output, /off for this deployment/);
  assert.match(output, /platform administrator/);
  assert.match(output, /href="\/admin\/features"/);
  assert.doesNotMatch(output, /Admin access required|service-status-|service-check-now/);
});

test("checking access never exposes service details", () => {
  const output = render("checking");
  assert.match(output, /Checking admin access/);
  assert.doesNotMatch(output, /service-status-|service-check-now|Missing setting/);
});
