import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { deploymentReadinessRecovery } from "../worlds/deployment-readiness-recovery.ts";
import { isRecord, records } from "../worlds/library.ts";

const test = spec.world(deploymentReadinessRecovery, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

test("an owner keeps a Google Cloud form through readiness failures and prepares approval without starting cloud services", async ({ world, user, probe, step, evidence }) => {
  await step("the owner can review billable cloud approval before preparing anything", async () => {
    await user.see({ text: /No deployments yet/ }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Create deployment" });
    await user.type({ role: "textbox", label: "Google Cloud project ID" }, "openwork-fixture");
    await user.type({ role: "textbox", label: "Google Cloud project number" }, "123456789012");
    await user.type({ role: "textbox", label: "Address" }, "openwork.example.test");
    await user.type({ role: "textbox", label: "Cloud DNS managed zone name for that address" }, "example-test");
    await user.type({ role: "textbox", label: "First administrator email" }, "owner@example.test");
    await user.see({ testId: "deployment-cost-consent" }, { text: /Only running the command creates or changes billable/ });
    await user.click({ role: "checkbox", label: /I control this Google Cloud project/ });
    const consent = await probe.has("Removing this record does not delete those resources or stop charges.");
    evidence.recordAssertionEvidence("billable approval remains explicit", `cloud billable-resource and retained-charge consent visible=${consent}`, consent);
    expect(consent).toBe(true);
    await user.screenshot();
  });
  await step("a late feature lock names the operator and preserves every entered value", async () => {
    await user.click({ testId: "create-deployment-submit" });
    await user.see({ text: /Google Cloud deployments aren't enabled.*OpenWork operator/ }, { timeoutMs: 60_000 });
    await user.see({ role: "textbox", label: "Google Cloud project ID" }, { value: "openwork-fixture" });
    await user.see({ role: "textbox", label: "Address" }, { value: "openwork.example.test" });
    await user.notSee({ text: /^feature_disabled$/ });
    const failed = (await world.faults.requestLog()).filter((entry) => entry.method === "POST" && entry.status === 404);
    evidence.recordAssertionEvidence("a late rollout change has actionable recovery", `actual create refusal=${failed.length}; project and address retained; operator named`, failed.length === 1);
    expect(failed.length).toBe(1);
    await user.screenshot();
  });
  await step("an unpublished installer requests operator publication without discarding the form", async () => {
    await user.click({ testId: "create-deployment-submit" });
    await user.see({ text: /OpenWork operator must publish and configure a verified installer release/ }, { timeoutMs: 60_000 });
    await user.see({ role: "textbox", label: "First administrator email" }, { value: "owner@example.test" });
    await user.notSee({ text: /^release_not_configured$/ });
    const failed = (await world.faults.requestLog()).filter((entry) => entry.method === "POST" && entry.status === 503);
    evidence.recordAssertionEvidence("publication is separate from permissions and sign-in", `actual publication refusal=${failed.length}; entered email retained; publication owner named`, failed.length === 1);
    expect(failed.length).toBe(1);
    await user.screenshot();
  });
  await step("after: one retry prepares the cloud handoff, but approval and healthy services are not claimed", async () => {
    await user.click({ testId: "create-deployment-submit" });
    await user.see({ role: "button", label: "Copy command" }, { timeoutMs: 60_000 });
    await user.see({ text: /Running it approves the installation and creates or changes billable resources/ });
    await user.see({ testId: "managed-deployment-status" }, { text: "Awaiting Google Cloud approval" });
    const read = await probe.api(world.den.admin, "/v1/managed-deployments");
    const deployment = isRecord(read.body) ? records(read.body.deployments)[0] : null;
    const run = isRecord(deployment?.run) ? deployment.run : null;
    const requests = await world.faults.requestLog();
    const prepared = requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/launch") && entry.status === 200);
    const cloudActions = requests.filter((entry) => /\/enroll|\/events|\/heartbeat/.test(entry.path));
    expect(run?.state).toBe("awaiting_approval");
    expect(prepared).toHaveLength(1);
    expect(cloudActions).toHaveLength(0);
    evidence.recordAssertionEvidence("prepared never means approved or healthy", `local approval handoffs=${prepared.length}; observed run=${run?.state}; installer/enrollment/health actions=${cloudActions.length}`, read.response.ok && prepared.length === 1 && run?.state === "awaiting_approval" && cloudActions.length === 0);
    await user.screenshot();
  });
});
