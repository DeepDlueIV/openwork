import { expect } from "vitest";
import { browserScript, spec } from "@openwork/testkit";
import { aiGatewayAdmin } from "../worlds/ai-gateway-admin.ts";

// Desktop 0.18.55–0.18.57 opens Den at /dashboard/gateway-providers from
// Settings → AI Providers. That page moved into AI Gateway, so the old address
// must forward there instead of showing a 404.
const test = spec.world(aiGatewayAdmin, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 600_000,
});

test("an owner clicks Gateway providers in an installed desktop and lands on AI Gateway's AI Providers, not a 404", async ({
  world, user, probe, step, evidence,
}) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const currentPath = () => page.eval(browserScript(() => `${location.pathname}${location.search}`, []));

  await step("before: the owner is signed in to Den on AI Gateway", async () => {
    await owner.see({ testId: "gateway-providers-empty" }, { timeoutMs: 90_000 });
  });

  await step("after: the address the desktop opens forwards to AI Providers", async () => {
    await owner.navigate(new URL("/dashboard/gateway-providers", world.den.ref.webUrl).toString());
    const landed = await page.eventually(currentPath, {
      within: 30_000, label: "redirect to AI Gateway, AI Providers", until: (path) => path.startsWith("/dashboard/ai-gateway"),
    });
    evidence.recordAssertionEvidence("/dashboard/gateway-providers forwards to AI Providers", landed, landed === "/dashboard/ai-gateway?tab=ai-providers");
    expect(landed).toBe("/dashboard/ai-gateway?tab=ai-providers");
    await owner.see({ role: "tab", label: "AI Providers" });
    await owner.see({ testId: "gateway-providers-empty" }, { timeoutMs: 30_000 });
    await owner.notSee({ role: "heading", label: "404" });
    await owner.screenshot();
  });
});
