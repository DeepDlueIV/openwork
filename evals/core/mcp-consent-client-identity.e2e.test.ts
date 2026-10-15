import { auditMcpTokenIssuance } from "@openwork/behaviors";
import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { mcpConsentClientIdentity } from "../worlds/mcp-consent-client-identity.ts";

const test = spec.world((seed) => mcpConsentClientIdentity(seed, { grants: true, misconfigured: true, rateLimitedDen: true }), {
  timeout: 420_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

test("a member sees which app is asking for MCP access, and can grant read-only, grant write, or decline", async ({ world, user, probe, step }) => {
  const person = user.on(world.web);
  const browser = probe.on(world.web);

  async function seeUnverifiedWarning(redirectUri: string) {
    await person.see({ testId: "mcp-unverified-app-warning" });
    await person.see({ text: "Unverified application" });
    await person.see({ text: "OpenWork has not verified who is requesting this access. Only authorize if you started this connection and trust the app to act on your behalf with the permissions shown." });
    await person.see({ text: "Check the return host supplied by this app:" });
    const host = new URL(redirectUri).host;
    await person.see({ testId: "mcp-warning-redirect-host", text: host });
    expect((await browser.dom('[data-testid="mcp-warning-redirect-host"]')).elements.map(element => element.text.trim())).toEqual([host]);
    expect((await browser.dom('[data-testid="mcp-unverified-app-warning"]')).elements.some(element => element.text.includes(redirectUri))).toBe(false);
    await person.notSee({ testId: "mcp-client-domain" });
    await person.notSee({ testId: "mcp-redirect-url" });
    expect((await browser.dom('details:not([open]):has([data-testid="mcp-redirect-url"])')).elements).toHaveLength(1);
    await person.click({ text: "Technical details" });
    await person.see({ testId: "mcp-redirect-url", text: redirectUri });
    expect((await browser.dom('details[open] [data-testid="mcp-redirect-url"]')).elements).toHaveLength(1);
    expect((await browser.dom('[data-testid="mcp-redirect-url"]')).elements.map(element => element.text.trim())).toEqual([redirectUri]);
    expect((await browser.dom('a[data-testid="mcp-redirect-url"], a:has([data-testid="mcp-redirect-url"]), [data-testid="mcp-redirect-url"] a')).elements).toHaveLength(0);
    expect((await browser.dom('[data-testid="mcp-redirect-url"] *')).elements).toHaveLength(0);
    await person.click({ text: "Technical details" });
    await person.notSee({ testId: "mcp-redirect-url" });
    expect((await browser.dom('details:not([open]):has([data-testid="mcp-redirect-url"])')).elements).toHaveLength(1);
    await person.see({ testId: "mcp-warning-redirect-host", text: host });
  }

  await step("given a member who signs in from the app's authorization link", async () => {
    await person.navigate(world.loopback.url);
    await person.see({ role: "textbox", label: /^email$/i }, { timeoutMs: 90_000 });
    await person.type({ role: "textbox", label: /^email$/i }, world.admin.email);
    await person.click({ role: "button", label: "Next" });
    await person.type({ role: "textbox", label: /^password$/i }, world.admin.password);
    await person.click({ role: "button", label: "Sign in" });
  });

  await step("after: an app returning to this computer shows both unverified-app and loopback warnings", async () => {
    await person.see({ testId: "mcp-client-name", text: world.loopback.name }, { timeoutMs: 90_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.loopback.redirectHost });
    await person.see({ testId: "mcp-loopback-warning" });
    await seeUnverifiedWarning(world.loopback.redirectUri);
    await person.screenshot();
  });

  await step("after: a named hosted app is still unverified, without a loopback warning", async () => {
    await person.navigate(world.hosted.url);
    await person.see({ testId: "mcp-client-name", text: world.hosted.name }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.hosted.redirectHost });
    await person.notSee({ testId: "mcp-loopback-warning" });
    await seeUnverifiedWarning(world.hosted.redirectUri);
    await person.screenshot();
  });

  await step("the card shows the app's registered name, never its raw client identifier", async () => {
    await person.see({ testId: "mcp-client-name", text: world.hosted.name });
    await person.notSee({ text: world.hosted.clientId });
    await person.see({ text: "Use your connected tools, including actions that create, change, or delete data" });
  });

  await step("after: an unnamed app shows the unverified warning alongside the host to check", async () => {
    await person.navigate(world.unnamed.url);
    await person.see({ testId: "mcp-client-name", text: "An app without a name" }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.unnamed.redirectHost });
    await person.see({ testId: "mcp-unnamed-app-line" });
    await person.see({ text: `This app did not share its name. Only continue if you know ${world.unnamed.redirectHost} and started this sign-in.` });
    await person.see({ role: "button", label: "Authorize this app" });
    await seeUnverifiedWarning(world.unnamed.redirectUri);
    await person.screenshot();
  });

  await step("after: hosted-app consent repeats the unverified warning before the member decides", async () => {
    await person.navigate(await world.consentUrl(world.hosted.authorizePath));
    await person.see({ text: `Allow ${world.hosted.name} to use` }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.hosted.redirectHost });
    await seeUnverifiedWarning(world.hosted.redirectUri);
    await person.notSee({ testId: "mcp-loopback-warning" });
    await person.see({ role: "button", label: `Authorize ${world.hosted.name}` });
    await person.see({ role: "button", label: "Deny" });
    await person.screenshot();
  });

  await step("the consent step names the app, the workspace and the return address, with Deny as a quiet action", async () => {
    await person.navigate(await world.consentUrl(world.loopback.authorizePath));
    await person.see({ text: `Allow ${world.loopback.name} to use` }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.loopback.redirectHost });
    await person.see({ testId: "mcp-loopback-warning" });
    await seeUnverifiedWarning(world.loopback.redirectUri);
    await person.see({ role: "button", label: `Authorize ${world.loopback.name}` });
    await person.see({ role: "button", label: "Deny" });
    await person.notSee({ text: /OpenWork MCP|Authorize MCP access/ });
    await person.screenshot();
  });

  await step("when the member denies the unverified app, it receives no authorization code", async () => {
    expect(world.callbacks()).toHaveLength(0);
    await person.click({ role: "button", label: "Deny" });
    await person.see({ text: "Authorization returned to client" }, { timeoutMs: 30_000 });
    expect(world.callbacks()).toEqual([{ hasCode: false, error: "access_denied", state: world.loopback.state }]);
    await person.screenshot();
  });

  await step("an unnamed app's consent step names the host to check", async () => {
    await person.navigate(await world.consentUrl(world.unnamed.authorizePath));
    await person.see({ text: "Allow this app to use" }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-unnamed-app-line" });
    await seeUnverifiedWarning(world.unnamed.redirectUri);
    await person.screenshot();
  });

  for (const grant of world.grants) {
    await step(`a ${grant.id} grant issues exactly the access shown, for the workspace the member picked`, async () => {
      expect(world.grantResult(grant.id)).toBeUndefined();
      await person.navigate(grant.url);
      await person.see({ testId: "mcp-client-name", text: grant.name }, { timeoutMs: 60_000 });
      await person.see({ text: "Find and read what is in this workspace" });
      const write = "Use your connected tools, including actions that create, change, or delete data";
      if (grant.scope.includes("mcp:write")) await person.see({ text: write });
      else await person.notSee({ text: write });
      await person.click({ role: "radio", label: new RegExp(world.selectedOrg.name) });
      await person.click({ role: "button", label: `Authorize ${grant.name}` });
      await person.see({ text: "Authorization returned to client" }, { timeoutMs: 30_000 });
      const issued = await probe.eventually(async () => world.grantResult(grant.id), { within: 15_000, label: `${grant.id} token exchange`, until: Boolean });
      expect(issued).toMatchObject({ status: 200, jwt: true, organizationId: world.selectedOrg.id });
      const granted = (issued?.scope ?? "").split(/\s+/).sort();
      expect(granted).toEqual(grant.scope.split(" ").sort());
      expect((issued?.tokenScope ?? "").split(/\s+/).sort()).toEqual(granted);
      expect(granted).not.toContain("mcp:app-host");
      await person.screenshot();
    });
  }

  if (world.misconfigured) {
    const misconfigured = world.misconfigured;
    await step("an app asking to return to an unregistered address gets OpenWork's own error page, not a redirect", async () => {
      await person.navigate(misconfigured.authorizeUrl);
      await person.see({ text: "The app's return address isn't registered" }, { timeoutMs: 60_000 });
      await person.see({ text: "What to do next" });
      await person.notSee({ text: "Something went wrong" });
      await person.notSee({ text: "invalid_redirect" });
      await person.click({ text: "Technical details" });
      await person.see({ text: "invalid_redirect" });
      await person.screenshot();
    });
  }

  if (world.rateLimited) {
    const rateLimited = world.rateLimited;
    await step("an MCP client gets a token only for the agent resource, and auth throttling never invalidates it", async () => {
      const audit = await auditMcpTokenIssuance(rateLimited);
      expect(audit.discoveredResource).toBe(`${rateLimited.apiUrl}/mcp/agent`);
      expect(audit.authorizeRejections).toEqual(Array(3).fill({ status: 400, redirected: false, error: "invalid_target" }));
      expect(audit.tokenRejections).toEqual(Array(3).fill({ status: 400, cacheControl: "no-store", error: "invalid_target", issuedToken: false }));
      expect(audit.issuedJwt).toBe(true);
      expect(audit).toMatchObject({ throttled: true, spoofedClientStatus: 429, otherClientStatus: 200, mcpChallenged: false, malformedTokenStatus: 401 });
      expect(audit.mcpStatuses).toEqual(Array(25).fill(200));
      expect(audit.malformedTokenChallenge).toContain("invalid_token");
    });
  }
});
