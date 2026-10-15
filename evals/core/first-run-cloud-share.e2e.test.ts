import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { clickText, stubInstallConfig } from "@openwork/behaviors";
import { firstRunCloudShareWorld } from "../worlds/first-run.ts";

const test = spec.world(firstRunCloudShareWorld);

test("first run signs in through the browser, then shares a skill with a colleague via a marketplace", async ({ world, user, agent, probe, step }) => {
  const appUser = user.on(world.app);
  const webUser = user.on(world.web);
  const appProbe = probe.on(world.app);
  const webProbe = probe.on(world.web);

  await step("The fresh app offers cloud sign-in", async () => {
    await appUser.see("Sign in to OpenWork Cloud");
    await appUser.notSee({ text: /something went wrong/i });
    await appUser.looks([
      "A fresh OpenWork app is visible offering to sign in to OpenWork Cloud",
      "No error or 'Something went wrong' message is visible",
    ]);
  });

  await step("Cloud sign-in hands off to the browser", async () => {
    await appUser.click("Sign in to OpenWork Cloud");
    await appUser.notSee({ testId: "welcome-team-signin" }, { timeoutMs: 30_000 });
    expect(await appProbe.hash()).not.toBe("#/welcome");
    const handoffUrl = new URL(world.den.ref.webUrl);
    handoffUrl.searchParams.set("mode", "sign-in");
    handoffUrl.searchParams.set("desktopAuth", "1");
    handoffUrl.searchParams.set("desktopScheme", "openwork");
    await webUser.navigate(handoffUrl.toString());
    await webUser.see({ role: "textbox", label: /email/i }, { timeoutMs: 90_000 });
  });

  await step("The browser signs in with the cloud account", async () => {
    await webUser.type({ role: "textbox", label: /email/i }, world.den.admin.email, { replace: true });
    await webUser.click({ role: "button", text: /^next$/i });
    await webUser.see({ role: "textbox", label: /password/i }, { timeoutMs: 60_000 });
    await webUser.type({ role: "textbox", label: /password/i }, world.den.admin.password, { replace: true });
    await webUser.click({ role: "button", text: /^sign in$/i });
    await webUser.see({ text: /you(?:'|’)re signed in|open openwork/i }, { timeoutMs: 120_000 });
    await webUser.notSee({ text: /invalid credentials|something went wrong/i });
    await webUser.looks([
      "A browser page shows an OpenWork Cloud sign-in result, not a sign-in form error",
      "No 'invalid credentials' or error banner is visible",
    ]);
  });

  await step("Already-installed Cloud users return through the same instance's auth route", async () => {
    // Control installation metadata only. Session hydration, navigation and grant
    // generation use the real Den, including its existing browser session.
    await using configWitness = await stubInstallConfig(world.web.client, world.den.ref.webUrl, world.den.ref.apiUrl);
    const origin = new URL(world.den.ref.webUrl).origin;
    const authUrl = `${origin}/?mode=sign-in&desktopAuth=1&desktopScheme=openwork`;
    const grants = new Set<string>();
    for (const installUrl of [`${origin}/install`]) {
      await webUser.navigate(installUrl);
      await webUser.see({ role: "link", text: "I already installed OpenWork" }, { timeoutMs: 90_000 });
      // The page offers no bare "open the app" link; "I already installed" goes to this instance's sign-in.
      expect(await webProbe.linkTargets('a[href="openwork://open"]')).toEqual([]);
      expect(await webProbe.linkTargets("a")).toContain(authUrl);
      // Activate the real anchor default action without depending on OS focus
      // after the preceding custom-protocol handoff.
      await clickText(world.web, "I already installed OpenWork");
      await webUser.see({ testId: "desktop-signed-in-handoff" }, { timeoutMs: 90_000 });
      expect(await webProbe.url()).toBe(authUrl);
      await webUser.see({ text: world.den.admin.email });
      await webUser.notSee({ role: "textbox", label: /password/i });
      const deepLink = await probe.eventually(async () => (await webProbe.linkTargets('[data-testid="desktop-signed-in-handoff"] input, [data-testid="desktop-signed-in-handoff"] a')).find((value) => value.startsWith("openwork://den-auth?")) ?? "",
        { within: 60_000, label: "install-issued desktop grant", until: (value) => value.includes("grant=") });
      if (typeof deepLink !== "string") throw new Error("Missing install handoff URL");
      const handoff = new URL(deepLink);
      const grant = handoff.searchParams.get("grant");
      expect(handoff.protocol).toBe("openwork:");
      expect(handoff.hostname).toBe("den-auth");
      expect(handoff.searchParams.get("denBaseUrl")).toBe(`${origin}/api/den`);
      expect(handoff.searchParams.has("token")).toBe(false);
      expect(grant).toBeTruthy();
      if (!grant) throw new Error("Missing desktop grant");
      expect(grants.has(grant)).toBe(false);
      grants.add(grant);
    }
  });

  await step("The browser-issued grant returns to the app", async () => {
    const deepLink = await probe.eventually(
      async () => (await webProbe.linkTargets('input, a[href^="openwork://"]')).find((value) => value.startsWith("openwork://") && value.includes("grant=")) ?? "",
      { within: 120_000, label: "browser-issued desktop handoff URL", until: (value) => value.startsWith("openwork://") },
    );
    if (typeof deepLink !== "string") throw new Error("The browser-issued handoff URL was not a string.");
    const handoff = new URL(deepLink);
    expect(handoff.hostname).toBe("den-auth");
    expect(handoff.searchParams.get("denBaseUrl")).toBe(`${new URL(world.den.ref.webUrl).origin}/api/den`);
    const grant = handoff.searchParams.get("grant");
    expect(grant, `unexpected deep link: ${deepLink}`).toBeTruthy();
    await agent.on(world.app).run("auth.exchange-grant", { grant, baseUrl: world.den.ref.webUrl });
    await appUser.see({ role: "button", label: /.+ — account and status$/ }, { timeoutMs: 180_000 });
    await appUser.click({ testId: "account-status-menu" });
    await appUser.see({ text: world.den.admin.email }, { timeoutMs: 180_000 });
    await appUser.press("Escape");
    await appUser.notSee({ text: /sign-in failure|something went wrong/i });
    await appUser.looks([
      "The app is back in focus and no longer offers a bare Sign in to OpenWork Cloud as the only action",
      "No sign-in failure message is visible",
    ]);
  });

  await step("The colleague can see the shared skill", async () => {
    const { plugin, skillName, visible } = await world.shareSkill();
    expect(visible.pluginNames).toContain(plugin.name);
    expect(visible.skillNames.some((name) => name.includes(skillName))).toBe(true);
  });

  await step("The app shows its extension library", async () => {
    await agent.on(world.app).run("route.extensions.skills");
    await appUser.see({ text: /library|extensions|skills|connections/i }, { timeoutMs: 60_000 });
    await appUser.notSee({ text: /something went wrong/i });
    await appUser.looks([
      "An OpenWork surface listing extensions, skills or connections is visible",
      "No 'Something went wrong' crash message is visible",
    ]);
  });
});
