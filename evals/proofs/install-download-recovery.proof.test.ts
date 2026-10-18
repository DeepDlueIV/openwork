import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { installDownloadRecovery } from "../worlds/install-download-recovery.ts";
import { denRememberLastOrganization } from "../worlds/den-remember-last-organization.ts";

const test = spec.world(installDownloadRecovery, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });
const choiceTest = spec.world(denRememberLastOrganization, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

choiceTest("a generic install link asks its recipient to sign in and choose their own organization", async ({ world, user, probe, step, evidence }) => {
  await step("the shared link does not authenticate its recipient", async () => {
    await user.navigate(new URL("/install?token=obsolete-fixture-token", world.den.ref.webUrl).toString());
    await user.see({ role: "textbox", label: /^email$/i }, { timeoutMs: 60_000 });
    const protectedPage = await probe.has("Download OpenWork");
    evidence.recordAssertionEvidence("an obsolete install token cannot grant access", `sign-in form shown; download page disclosed=${protectedPage}`, !protectedPage);
    expect(protectedPage).toBe(false);
    await user.screenshot();
  });
  await step("the authenticated recipient chooses from their real memberships", async () => {
    await user.type({ role: "textbox", label: /^email$/i }, world.first.session.email);
    await user.click({ role: "button", label: "Next" });
    await user.type({ role: "textbox", label: /^password$/i }, world.first.session.password, { sensitive: true });
    await user.click({ role: "button", label: "Sign in" });
    await user.see({ role: "heading", label: "Choose an organization" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: new RegExp(world.organizationA.name) });
    await user.see({ role: "button", label: new RegExp(world.organizationB.name) });
    const chooser = await probe.has("Choose an organization");
    evidence.recordAssertionEvidence("the link does not select its sender's organization", `authenticated recipient has two memberships; explicit chooser=${chooser}`, chooser);
    expect(chooser).toBe(true);
    await user.screenshot();
  });
  await step("after: only the recipient's explicit organization supplies the install setup", async () => {
    await user.click({ role: "button", label: new RegExp(world.organizationB.name) });
    await user.see({ testId: "install-organization" }, { text: `Organization: ${world.organizationB.name}`, timeoutMs: 60_000 });
    const url = await probe.url();
    expect(url).not.toContain("token=");
    const selected = await probe.has(`Organization: ${world.organizationB.name}`);
    evidence.recordAssertionEvidence("the chosen membership supplies the approved download", `selected organization=${world.organizationB.name}; obsolete token retained=${url.includes("token=")}`, selected && !url.includes("token="));
    await user.screenshot();
  });
});

test("a signed-in member can retry an unavailable installer without a timed success claim or hidden download step", async ({ world, user, probe, step, evidence }) => {
  let requestedAt = 0;
  await step("the recipient authenticates for their own organization and obsolete link tokens are ignored", async () => {
    await user.see({ role: "heading", label: "Set up OpenWork Enterprise" }, { timeoutMs: 90_000 });
    const url = await probe.url();
    expect(url).not.toContain("token=");
    evidence.recordAssertionEvidence("the install page has no reusable access token", `organization=Install recovery; obsolete token removed=${!url.includes("token=")}`, !url.includes("token="));
    await user.screenshot();
  });
  await step("an unavailable download stays requested with a visible retry instead of advancing", async () => {
    requestedAt = Date.now();
    await user.click({ testId: "install-download-primary" });
    await user.see("Download requested");
    await user.see({ role: "link", label: "Retry download" });
    await user.notSee("Download started");
    const log = await probe.eventually(() => world.faults.requestLog(), { within: 15_000, label: "the installer request really failed", until: (requests) => requests.some((entry) => entry.path.includes("/v1/me/install/") && entry.status === 503) });
    const failures = log.filter((entry) => entry.path.includes("/v1/me/install/") && entry.status === 503).length;
    evidence.recordAssertionEvidence("the failed request never becomes an installed state", `actual installer 503 requests=${failures}; Download requested and Retry download remain visible`, failures === 1);
    expect(failures).toBe(1);
    await user.screenshot();
  });
  await step("after: more than five seconds still leaves recovery visible until the member confirms the file", async () => {
    const elapsed = await probe.eventually(() => Date.now() - requestedAt, { within: 10_000, label: "observe past the former five-second timer", until: (value) => value >= 6000 });
    await user.see("Download requested");
    await user.see({ role: "link", label: "Retry download" });
    await user.notSee("Download started");
    await user.click({ role: "link", label: "Retry download" });
    const log = await probe.eventually(() => world.faults.requestLog(), { within: 15_000, label: "retry sends another installer request", until: (requests) => requests.filter((entry) => entry.path.includes("/v1/me/install/") && entry.status === 503).length === 2 });
    const failures = log.filter((entry) => entry.path.includes("/v1/me/install/") && entry.status === 503).length;
    evidence.recordAssertionEvidence("time passing does not certify a download", `elapsed=${elapsed}ms; actual failed download attempts=${failures}; recovery visible`, elapsed >= 6000 && failures === 2);
    await user.screenshot();
    await user.click({ role: "button", label: "I have the installer" });
    await user.see({ testId: "install-app-ready" });
    await user.screenshot();
  });
});
