import { expect } from "vitest";
import { spec, readDenClientState, evalIn, browserScript, electronProfilePaths } from "@openwork/testkit";
import { readFile } from "node:fs/promises";
import { handoffWorld } from "../worlds/split-origin-sso.ts";

// Browser-issued grants, with only OS protocol delivery bridged to the real
// renderer listener. No auth.exchange-grant shortcut is used.
const needsPublishedLab = process.env.SWITCHORG_SINGLE_HOST === "1"
  || process.env.SWITCHORG_CHARACTERIZE === "1"
  || (Boolean(process.env.OPENWORK_EVAL_ELECTRON_BINARY) && process.env.SWITCHORG_SOURCE !== "1");

const test = spec.world(handoffWorld, {
  timeout: 480_000,
  resources: { surfaces: ["desktop", "web"], services: ["den", "mock"],
    nativeReason: "The native bootstrap and real renderer deep-link listener must retain enrollment and confirmation state." },
  needs: needsPublishedLab ? { env: ["OPENWORK_EVAL_ELECTRON_BINARY", "OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"] } : {},
});

test(process.env.SWITCHORG_SINGLE_HOST === "1"
  ? "published single-host blank API origin advertises a different API hostname and prompts"
  : process.env.SWITCHORG_CHARACTERIZE === "1"
  ? "published split-origin browser reauthentication repeats the server-switch confirmation"
  : "two browser sign-ins to the configured split-origin Den do not request a server switch", async ({ world, user, probe, evidence }) => {
  if (process.env.SWITCHORG_SINGLE_HOST === "1") {
    expect(new URL(world.den.ref.webUrl).origin).toBe(new URL(world.den.ref.apiUrl).origin);
  } else {
    expect(new URL(world.den.ref.webUrl).origin).not.toBe(new URL(world.den.ref.apiUrl).origin);
  }
  const launch = await world.launch();
  if (!launch.profileDir) throw new Error("Missing owned desktop profile");
  const bootstrapPath = electronProfilePaths(launch.profileDir).bootstrapPath;
  const bootstrapBefore = JSON.parse(await readFile(bootstrapPath, "utf8"));
  expect(bootstrapBefore).toMatchObject({ baseUrl: world.den.ref.webUrl, apiBaseUrl: world.den.ref.apiUrl });
  const build = await launch.buildInfo();
  if (!world.source) expect(build?.version).toBe(process.env.OPENWORK_EVAL_RELEASED_VERSION);
  await probe.eventually(() => launch.rootText(), { within: 90_000, until: (text) => /Sign in to /.test(text), label: "configured sign-in surface" });
  await probe.eventually(() => evalIn(launch.app, () => !document.body.innerText.includes("Preparing workspace")), {
    within: 120_000, label: "boot overlay gone",
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const browser = world.browsers[attempt];
    if (!browser) throw new Error("Missing isolated browser");
    const signInUrl = `${world.den.ref.webUrl}/?mode=sign-in&desktopAuth=1&desktopScheme=openwork`;
    if (world.sso) {
      await user.on(browser).navigate(signInUrl);
      await user.on(browser).click({ role: "button", text: "Continue with SSO" });
      await user.on(browser).see({ role: "button", text: "Approve sign-in" }, { timeoutMs: 60_000 });
      expect(await evalIn(browser, () => location.origin)).toBe(world.sso.issuer);
      await user.on(browser).click({ role: "button", text: "Approve sign-in" });
    } else {
      await world.signInPassword(browser, signInUrl);
    }
    const deepLink = await world.readHandoffLink(browser);
    await evalIn(launch.app, () => {
      Reflect.set(window, "__splitOriginHandoffStatus", null);
      if (!Reflect.get(window, "__splitOriginHandoffListener")) {
        window.addEventListener("openwork-den-session-updated", (event) => {
          if (event instanceof CustomEvent) Reflect.set(window, "__splitOriginHandoffStatus", event.detail?.status);
        });
        Reflect.set(window, "__splitOriginHandoffListener", true);
      }
    });
    await evalIn(launch.app, browserScript((url) => {
      window.dispatchEvent(new CustomEvent("openwork:deep-link", { detail: { urls: [url] } }));
    }, [deepLink]));
    const outcome = await probe.eventually(async () => ({
      dialog: await evalIn(launch.app, () => document.body.innerText.includes("Switch organization server?")),
      state: await readDenClientState(launch.app),
      status: await evalIn(launch.app, () => Reflect.get(window, "__splitOriginHandoffStatus")),
    }), { within: 60_000, until: (value) => value.dialog || value.status === "success" || value.status === "error", label: `handoff ${attempt + 1} outcome` });
    await user.on(launch.app).screenshot();
    if (process.env.SWITCHORG_SINGLE_HOST === "1") {
      const runtime: unknown = await (await fetch(`${world.den.ref.webUrl}/api/runtime-config`)).json();
      const derived = new URL(world.den.ref.webUrl);
      derived.hostname = `api.${derived.hostname}`;
      expect(runtime).toMatchObject({ denApiUrl: derived.origin });
      expect(outcome.dialog).toBe(true);
      await user.on(launch.app).see({ text: new RegExp(derived.host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
      evidence.recordAssertionEvidence("Blank API origin still prompts on the published single-host deployment",
        "The web runtime configuration advertised an api-prefixed hostname; the browser handoff reached the real renderer comparison and showed a switch confirmation. Grant exchange is not claimed in this variant.", true);
      await user.on(launch.app).click({ role: "button", text: /^Cancel$/ });
      return;
    }
    // Characterization mode captures both reported occurrences and confirms the
    // workaround; the default assertion is the regression contract (RED first).
    if (process.env.SWITCHORG_CHARACTERIZE === "1") {
      expect(outcome.dialog).toBe(true);
      await user.on(launch.app).click({ role: "button", text: /^Switch & sign in$/ });
    } else {
      expect(outcome.dialog, `same deployment requested a switch on handoff ${attempt + 1}`).toBe(false);
    }
    await probe.eventually(() => evalIn(launch.app, () => Reflect.get(window, "__splitOriginHandoffStatus")), {
      within: 60_000, until: (status) => status === "success", label: `handoff ${attempt + 1} exchange completed`,
    });
    const signedIn = await probe.eventually(() => readDenClientState(launch.app), {
      within: 60_000, until: (state) => state.authTokenPresent, label: "handoff authenticated",
    });
    expect(signedIn.activeOrgName).toBe(world.organizationIdentity.name);
    expect(signedIn.activeOrgId).toBe(world.organizationIdentity.id);
    expect(JSON.parse(await readFile(bootstrapPath, "utf8"))).toMatchObject({ baseUrl: world.den.ref.webUrl, apiBaseUrl: world.den.ref.apiUrl });
    evidence.recordAssertionEvidence(`Browser handoff ${attempt + 1} completed with the expected confirmation behavior`,
      `${world.sso ? "OIDC witness SSO" : "Password"} browser sign-in issued a real grant; the renderer ingress ${outcome.dialog ? "required confirmation (published characterization)" : "did not request a same-deployment switch"}; exchange succeeded, the expected organization is active, and the durable web/API pair is unchanged.`, true);
    // Reauthenticate from a second fresh browser without ordinary sign-out,
    // which currently clears the configured server outside developer mode.
  }
  const before = await readDenClientState(launch.app);
  const durableBefore = await readFile(bootstrapPath, "utf8");
  await evalIn(launch.app, async () => {
    const keys = ["openwork.den.authToken", "openwork.den.baseUrl", "openwork.den.apiBaseUrl", "openwork.den.sessionOrigin", "openwork.den.activeOrgId"];
    const stored = keys.map((key) => localStorage.getItem(key));
    if (!stored[0]) throw new Error("Expected an authenticated session before negative witness");
    const readBootstrap = async () => {
      const bridge = window.__OPENWORK_ELECTRON__;
      if (!bridge?.invokeDesktop) throw new Error("Missing native bootstrap query bridge");
      return JSON.stringify(await bridge.invokeDesktop("getDesktopBootstrapConfig"));
    };
    const bootstrap = await readBootstrap();
    // Credential values remain entirely inside the renderer closure.
    Reflect.set(window, "__splitOriginIdentityUnchanged", async () => ({
      sessionUnchanged: keys.every((key, index) => localStorage.getItem(key) === stored[index]),
      bootstrapUnchanged: await readBootstrap() === bootstrap,
    }));
  });
  const retainedIdentity = () => evalIn(launch.app, async () => {
    const check = Reflect.get(window, "__splitOriginIdentityUnchanged");
    if (typeof check !== "function") throw new Error("Missing identity witness");
    return await check();
  });
  // Guard-only negative: no grant exchange is authorized for a different web
  // origin until the person accepts. No second Den is needed to test rejection.
  await evalIn(launch.app, browserScript((origin) => {
    const url = new URL("openwork://den-auth");
    url.searchParams.set("grant", "different-origin-unused-grant");
    url.searchParams.set("denBaseUrl", `${origin}/api/den`);
    window.dispatchEvent(new CustomEvent("openwork:deep-link", { detail: { urls: [url.toString()] } }));
  }, [world.foreign.url]));
  await user.on(launch.app).see({ text: "Switch organization server?" });
  await user.on(launch.app).screenshot();
  expect(world.foreign.requests).toEqual([]);
  expect(await retainedIdentity()).toEqual({ sessionUnchanged: true, bootstrapUnchanged: true });
  await user.on(launch.app).click({ role: "button", text: /^Cancel$/ });
  await user.on(launch.app).notSee({ text: "Switch organization server?" });
  expect(world.foreign.requests).toEqual([]);
  expect(await retainedIdentity()).toEqual({ sessionUnchanged: true, bootstrapUnchanged: true });
  expect(await readDenClientState(launch.app)).toEqual(before);
  expect(await readFile(bootstrapPath, "utf8")).toBe(durableBefore);
  evidence.recordAssertionEvidence("A different web origin still asks before switching",
    "A fresh foreign-origin HTTP witness received no requests while confirmation was pending or after Cancel; the authenticated identity and byte-identical durable bootstrap were retained. This is a guard witness, not a second-Den exchange.", true);
});
