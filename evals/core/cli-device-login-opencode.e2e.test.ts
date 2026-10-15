import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { opencodePluginSignIn } from "../worlds/opencode-plugin-sign-in.ts";

// CLI-SIGN-IN's second journey: the same browser device sign-in, driven by the
// OpenCode plugin instead of the OpenWork CLI (a different binary and install).
const test = spec.world(opencodePluginSignIn, {
  timeout: 900_000,
  needs: { commands: ["pnpm", "node", "git"] },
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a person signs OpenCode in from their browser without typing a password, even when one token poll is rate-limited", async ({ world, user, probe, step }) => {
  const person = user.on(world.web);
  const consent = `Only approve if you started this in your own terminal and the code matches. OpenWork - OpenCode Plugin will act as ${world.den.admin.email} in ${world.organizationName} until you sign out of it.`;

  const login = await world.startLogin("browser", { throttleTokenPoll: true });

  await step("the browser names OpenCode, shows the code from the terminal, and says what approving allows", async () => {
    const url = new URL(login.verificationUrl);
    expect(url.pathname).toBe("/device");
    expect(url.searchParams.get("return_to")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/openwork\/callback$/);
    await person.navigate(login.verificationUrl);
    await person.see({ role: "heading", label: "Sign in OpenWork - OpenCode Plugin?" }, { timeoutMs: 90_000 });
    await person.see({ testId: "device-user-code", text: login.userCode });
    await person.see({ text: "$ opencode auth login openwork" });
    await person.see({ testId: "device-consent-line", text: consent });
    await person.see({ role: "button", label: "Sign in OpenWork - OpenCode Plugin" });
    await person.see({ role: "button", label: "Deny" });
    await person.screenshot();
  });

  await step("when one token poll is rate-limited, the same sign-in keeps waiting for browser approval", async () => {
    const fault = await probe.eventually(() => world.tokenPollFault(), {
      within: 60_000,
      intervalMs: 200,
      label: "one plain HTTP 429 followed by a retry before approval",
      until: (value) => value.injected === 1 && value.retriedPolls > 0,
    });
    expect(fault).toMatchObject({ http429s: 1, authorizations: 1 });
    await person.see({ testId: "device-user-code", text: login.userCode });
  });

  await step("approving the same code sends the browser back to OpenCode, which is now signed in", async () => {
    await person.click({ role: "button", label: "Sign in OpenWork - OpenCode Plugin" });
    await person.see({ text: "OpenCode is connected to OpenWork" }, { timeoutMs: 30_000 });
    await person.see({ text: "You can close this tab and go back to OpenCode." });
    await person.screenshot();
    const result = await login.finished;
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("Connected to OpenWork Cloud");
    expect((await world.run(["auth", "list"])).stdout).toContain(world.den.admin.email);
    expect(await world.tokenPollFault()).toMatchObject({ injected: 1, http429s: 1, authorizations: 1 });
  });

  await step("OpenCode loads OpenWork's MCP gateway with that sign-in", async () => {
    await probe.eventually(async () => (await world.run(["mcp", "list"])).stdout, {
      within: 60_000,
      intervalMs: 2_000,
      label: "openwork-cloud MCP server connected",
      until: (servers) => /openwork-cloud[\s\S]*connected/i.test(servers),
    });
  });

  await step("a return address that is not on this machine is ignored", async () => {
    const tampered = await world.startLogin("code");
    const url = new URL(tampered.verificationUrl);
    url.searchParams.set("return_to", "https://example.com/openwork/callback");
    await person.navigate(url.toString());
    await person.see({ testId: "device-user-code", text: tampered.userCode }, { timeoutMs: 60_000 });
    await person.click({ role: "button", label: "Sign in OpenWork - OpenCode Plugin" });
    await person.see({ text: "OpenWork - OpenCode Plugin is signed in" }, { timeoutMs: 30_000 });
    await person.see({ text: "Return to OpenCode." });
    await person.screenshot();
    expect((await tampered.finished).status).toBe(0);
  });
});
