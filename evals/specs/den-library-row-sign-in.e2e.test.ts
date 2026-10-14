import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denLibraryRowSignIn } from "../worlds/den-library-manage.ts";

// The sharing journey covers adding a connector. This journey starts with
// existing connectors and checks the member's actions in the Library rows.
const test = spec.world(denLibraryRowSignIn, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

test("a member can read and use Library connector sign-in buttons", async ({ world, user, probe, step, evidence }) => {
  const row = (name: string) => `[data-library-item="${name}"]`;
  const action = (name: string) => `${row(name)} [data-item-action] button`;

  await step("after: required sign-ins have labeled buttons instead of dots", async () => {
    // The report is a 1666 × 294 crop. Its full window height is not known.
    await user.resizeViewport({ width: 1666, height: 900, deviceScaleFactor: 2 });
    await user.reload();
    await user.see({ role: "button", label: "Sign in" }, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: "Add key" }, { timeoutMs: 30_000 });
    await user.see({ role: "button", label: "More for Slack" });
    await user.see({ role: "link", label: "Sign in" });
    const signIn = (await probe.dom(action("Stripe"))).elements[0];
    const addKey = (await probe.dom(action("Keyed Docs"))).elements[0];
    const native = (await probe.dom(`${row("Google Workspace")} [data-item-action] a`)).elements[0];
    const icon = (await probe.dom(`${action("Stripe")} svg`)).elements[0];
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "Sign-in labels are inside the controls",
      `Stripe text=${JSON.stringify(signIn?.text)}, width=${signIn?.rect.width}, icon width=${icon?.rect.width ?? "none"}; Keyed Docs text=${JSON.stringify(addKey?.text)}; Google Workspace text=${JSON.stringify(native?.text)}`,
      signIn?.text === "Sign in" && addKey?.text === "Add key" && native?.text === "Sign in",
    );
    expect(signIn?.text).toBe("Sign in");
    expect(addKey?.text).toBe("Add key");
    expect(native?.text).toBe("Sign in");
    expect((await probe.dom(`${row("Stripe")} [data-item-status]`)).elements).toHaveLength(0);
  });

  for (const width of [640, 375, 320]) {
    await step(`after: the sign-in controls fit in a ${width}px window`, async () => {
      await user.resizeViewport({ width, height: 900, deviceScaleFactor: 1 });
      await user.see({ role: "button", label: "Sign in" });
      const page = await probe.dom("[data-library-integrated-row]");
      const buttons = (await probe.dom(`${action("Stripe")}, ${action("Keyed Docs")}, ${row("Google Workspace")} [data-item-action] a`)).elements;
      expect(page.documentWidth).toBeLessThanOrEqual(page.viewportWidth);
      expect(buttons).toHaveLength(3);
      for (const button of buttons) {
        expect(button.rect.width).toBeGreaterThanOrEqual(60);
        expect(button.rect.height).toBeGreaterThanOrEqual(28);
        expect(button.rect.right).toBeLessThanOrEqual(page.viewportWidth);
      }
      const labels = (await probe.dom(`${action("Stripe")} > div, ${action("Keyed Docs")} > div`)).elements;
      for (const label of labels) {
        const button = buttons.find((item) => item.text === label.text);
        expect(button).toBeDefined();
        expect(label.rect.left).toBeGreaterThanOrEqual(button?.rect.left ?? Infinity);
        expect(label.rect.right).toBeLessThanOrEqual(button?.rect.right ?? -Infinity);
      }
      evidence.recordAssertionEvidence("the labels remain inside the controls", `${width}px: ${buttons.length} controls, each at least 60 × 28px; no horizontal overflow or clipped labels`, true);
      await user.screenshot();
    });
  }

  await step("the ready connector keeps its menu and the member cannot remove it", async () => {
    await user.click({ role: "button", label: "More for Slack" });
    await user.see({ role: "menuitem", label: "Open" });
    await user.notSee({ role: "menuitem", label: /Remove/ });
    await user.notSee({ role: "menuitem", label: "Share" });
    evidence.recordAssertionEvidence("member permissions stay unchanged", "Slack has Open, but no Share or Remove action", true);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("the key button opens the real form and Cancel returns to the Library", async () => {
    await user.click({ role: "button", label: "Add key" });
    await user.see({ testId: "member-api-key-dialog" });
    await user.see({ role: "heading", label: "Add key for Keyed Docs" });
    await user.screenshot();
    await user.click({ role: "button", label: "Cancel" });
    await probe.eventually(async () => (await probe.dom('[data-testid="member-api-key-dialog"]')).elements.length, {
      within: 5_000, label: "the key dialog finishes closing", until: (count) => count === 0,
    });
    await user.see({ role: "button", label: "Add key" });
    // Automatic focus return fails on the clean base too. Keep the separate
    // control result in the ENG-743 evidence; do not change the shared dialog here.
    evidence.recordAssertionEvidence("Cancel leaves the key unchanged", "The key form closes; Add key remains available", true);
  });

  await step("a native connector still opens its sign-in page", async () => {
    await user.click({ role: "link", label: "Sign in" });
    const path = await probe.eventually(() => world.location(), {
      within: 30_000, label: "the native connection route opens", until: (value) => value.includes("/your-connections") && value.includes(world.connections.nativeId),
    });
    evidence.recordAssertionEvidence("the native sign-in destination is unchanged", `Opened Your Connections for the selected test connection: ${path.includes(world.connections.nativeId)}`, true);
    await user.screenshot();
    await user.navigate(`${world.den.ref.webUrl}/dashboard/library`);
    await user.see({ role: "button", label: "Sign in" });
  });

  await step("a failed sign-in leaves a readable button for retry", async () => {
    await user.click({ role: "button", label: "Sign in" });
    await probe.eventually(() => world.proxy.requestLog(), {
      within: 30_000, label: "the test sign-in failure occurs", until: (requests) => requests.some((request) => request.path === world.startPath && request.status === 503),
    });
    await probe.eventually(async () => (await probe.dom(`${action("Stripe")}:not([disabled])`)).elements.length, {
      within: 10_000, label: "the sign-in button accepts a retry", until: (count) => count === 1,
    });
    await user.see({ role: "button", label: "Sign in" });
    await user.notSee({ role: "button", label: "More for Stripe" });
    const label = (await probe.dom(action("Stripe"))).elements[0]?.text;
    evidence.recordAssertionEvidence("failure does not mark the connector ready", `First sign-in request returned 503; button text=${JSON.stringify(label)}; no Ready menu`, label === "Sign in");
    expect(label).toBe("Sign in");
    await user.screenshot();
    await world.closeSignInTab();
  });

  await step("keyboard retry keeps the button width while sign-in starts", async () => {
    await user.click({ role: "button", label: "More for Slack" });
    await user.see({ role: "menuitem", label: "Open" });
    await user.press("Escape");
    await probe.eventually(async () => (await probe.dom('[role="menuitem"]')).elements.length, {
      within: 5_000, label: "the ready connector menu finishes closing", until: (count) => count === 0,
    });
    for (let count = 0; count < 20 && !(await probe.dom(action("Stripe"))).elements[0]?.focused; count += 1) {
      await user.press("Tab");
    }
    expect((await probe.dom(`${action("Stripe")}:focus-visible`)).elements).toHaveLength(1);
    const before = (await probe.dom(action("Stripe"))).elements[0]?.rect;
    await user.screenshot();
    await user.press("Enter");
    const pending = await probe.eventually(async () => (await probe.dom(`${action("Stripe")}[disabled]`)).elements, {
      within: 5_000, label: "the retry is pending", until: (items) => items.length === 1,
    });
    const spinner = (await probe.dom(`${action("Stripe")} svg`)).elements[0];
    expect(pending[0]?.rect.width).toBe(before?.width);
    expect(spinner?.rect.width).toBeGreaterThanOrEqual(13);
    evidence.recordAssertionEvidence("the pending button does not shrink to a dot", `Keyboard focus visible; Enter starts sign-in; width ${before?.width} → ${pending[0]?.rect.width}px; spinner ${spinner?.rect.width}px; button disabled`, true);
    await user.screenshot();
  });

  await step("after: real test-provider sign-in replaces the button with Ready and a menu", async () => {
    await user.see({ role: "button", label: "More for Stripe" }, { timeoutMs: 60_000 });
    const status = (await probe.dom(`${row("Stripe")} [data-item-status]`)).elements[0]?.text;
    const requests = await world.slack.requests();
    const authorized = requests.some((request) => request.path === "/authorize");
    const exchanged = requests.some((request) => request.path === "/token" && request.method === "POST");
    expect(status).toBe("Ready");
    expect(authorized).toBe(true);
    expect(exchanged).toBe(true);
    await user.click({ role: "button", label: "More for Stripe" });
    await user.see({ role: "menuitem", label: "Open" });
    await user.notSee({ role: "menuitem", label: /Remove/ });
    evidence.recordAssertionEvidence("the real OAuth flow completes against the test provider", `Authorize request=${authorized}; token exchange=${exchanged}; row state=${status}; member menu has no Remove action`, true);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("saving a test key does not give another member access", async () => {
    await user.click({ role: "button", label: "Add key" });
    await user.type({ label: "Keyed Docs key" }, "eng-743-isolated-test-key");
    await user.click({ role: "button", label: "Save key" });
    await user.see({ role: "heading", label: "Keyed Docs: key saved" }, { timeoutMs: 30_000 });
    await user.screenshot();
    await user.click({ role: "button", label: "Done" });
    const otherLibrary = (await world.library(world.den.members.kai)).map((item) => item.name);
    expect(otherLibrary).not.toContain("Stripe");
    expect(otherLibrary).not.toContain("Keyed Docs");
    evidence.recordAssertionEvidence("only the member's test key is saved", "The real key form reports key saved; a member without grants still cannot see Stripe or Keyed Docs", true);
  });
});
