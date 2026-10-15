import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { redirectSignInWeb } from "../worlds/mcp-redirect-sign-in-web.ts";

const test = spec.world(redirectSignInWeb, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a member sees what to do when a login redirect has no sign-in metadata", async ({ world, user, probe, step, evidence }) => {
  await step("given a saved provider that redirects to a login page", async () => {
    await user.reload();
    await user.see({ text: "exp-mcpredirect-provider" }, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: "Sign in" });
    evidence.recordAssertionEvidence("The member can start sign-in from their connections", "A saved synthetic OAuth provider appears with its Sign in button.", true);
  });
  await step("when the member clicks Sign in, OpenWork explains why sign-in cannot start", async () => {
    await user.click({ role: "button", label: "Sign in" });
    const tab = await probe.eventually(() => world.signInTab(), { within: 30_000, label: "OpenWork sign-in tab", until: (value) => Boolean(value) });
    if (!tab) throw new Error("Sign-in tab missing");
    try {
      await world.sizeSignInTab(tab);
      const person = user.on(tab);
      await person.see({ text: /Couldn't start the exp-mcpredirect-provider sign-in/ }, { timeoutMs: 30_000 });
      await person.reload();
      await person.see({ text: /Couldn't start the exp-mcpredirect-provider sign-in/ }, { timeoutMs: 30_000 });
      expect(await world.healthySignInLayout(tab)).toBe(true);
      await person.screenshot();
      await person.see({ text: /publishes no valid sign-in information/ });
      await person.see({ text: /ask the server administrator/ });
      evidence.recordAssertionEvidence("The member gets actionable guidance instead of an HTML routing error", "OpenWork's real sign-in tab says the server publishes no valid sign-in information and asks for manual configuration or administrator help.", true);
    } finally { tab.client.close(); }
  });
  await step("then the provider's login redirect has not been requested", async () => {
    await user.see({ text: "exp-mcpredirect-provider" });
    expect(world.mock.requests.some((request) => request.path === "/login" || request.authorized)).toBe(false);
    evidence.recordAssertionEvidence("The login target receives neither requests nor credentials", "The neutral provider observed zero login-page requests and zero requests with authorization or cookies.", true);
  });
});
