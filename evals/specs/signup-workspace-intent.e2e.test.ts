import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { signupWorkspace } from "../worlds/signup-workspace.ts";

// A new owner signs up, names a workspace, optionally invites people, and lands
// on the dashboard or their requested model settings.
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const simplifiedTest = spec.world((seed) => signupWorkspace(seed, { simplified: true }), {
  timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] },
});

for (const destination of ["skip", "invite", "models"]) {
  const invite = destination === "invite";
  const modelsIntent = destination === "models";
  simplifiedTest(`a new owner reaches ${modelsIntent ? "their requested model settings" : "the dashboard"} after name, workspace, and ${invite ? "sending an invitation" : "skipping optional invitations"}`, async ({ world, user, probe, evidence, step }) => {
    const expectedPath = modelsIntent ? "/dashboard/ai-gateway" : "/dashboard";
    let orgId = "";
    const scope = () => ({ "x-openwork-org-id": orgId });

    await step("a person enters their name and creates an account", async () => {
      if (modelsIntent) await user.navigate(new URL("/?intent=models", world.den.ref.webUrl).toString());
      await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 90_000 });
      await user.see({ text: "Invite (optional)" });
      await user.notSee({ text: "Good work starts here." });
      await user.type({ role: "textbox", label: "Email" }, world.owner.email);
      await user.click({ role: "button", label: "Next" });
      await user.see({ role: "textbox", label: "Name" });
      await user.screenshot();
      await user.type({ role: "textbox", label: "Name" }, world.owner.name);
      await user.type({ role: "textbox", label: "Password" }, world.owner.password);
      await user.click({ role: "button", label: "Sign up" });
      await user.see({ role: "textbox", label: "Workspace name" }, { timeoutMs: 90_000 });
      await world.adoptSignedInOwner();
      const result = await probe.api(world.den.admin, "/v1/me/orgs");
      expect(isRecord(result.body) && result.body.orgs).toEqual([]);
      evidence.recordAssertionEvidence("Account creation keeps workspace creation separate", "The new owner has no workspaces and sees the workspace name field.", true);
    });

    await step("after: the owner names a workspace without setup choices", async () => {
      await user.notSee({ text: "On my own" });
      await user.notSee({ text: "How should your team’s desktop app work?" });
      await user.notSee({ text: /^Tools$/ });
      await user.screenshot();
      await user.type({ role: "textbox", label: "Workspace name" }, "Simple workspace");
      await user.click({ role: "button", label: "Create workspace" });
      await user.see({ testId: "onboarding-teammates" }, { timeoutMs: 90_000 });
      const result = await probe.api(world.den.admin, "/v1/me/orgs");
      if (!isRecord(result.body) || !Array.isArray(result.body.orgs)) throw new Error("Expected workspaces");
      expect(result.body.orgs).toHaveLength(1);
      const org = result.body.orgs.find(isRecord);
      if (typeof org?.id !== "string" || typeof org.slug !== "string") throw new Error("Expected created workspace");
      orgId = org.id;
      evidence.recordAssertionEvidence("One name creates one workspace", "Exactly one workspace was created; no personal/team or restricted-policy choice was required.", true);
    });

    await step(invite ? "the owner explicitly sends an invitation" : "the owner skips invitations without sending a typed address", async () => {
      await user.type({ role: "textbox", label: "Teammate email 1" }, world.invitees[0]);
      if (invite) {
        await user.click({ role: "button", label: "Send invitations" });
        await user.see({ text: /^Invitation sent$/ }, { timeoutMs: 30_000 });
      }
      await user.screenshot();
      await user.click({ role: "button", label: invite ? "Open workspace" : "Skip and open workspace" });
      await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
      await probe.eventually(() => world.pathname(), { within: 30_000, label: "requested destination", until: (path) => path === expectedPath });
      const result = await probe.api(world.den.admin, "/v1/org", { headers: scope() });
      if (!isRecord(result.body) || !Array.isArray(result.body.invitations)) throw new Error("Expected invitations");
      expect(result.body.invitations.filter(isRecord).map((entry) => entry.email)).toEqual(invite ? [world.invitees[0]] : []);
      evidence.recordAssertionEvidence("Only explicit send creates an invitation", `Invitations: ${invite ? world.invitees[0] : "none"}; the owner went directly to ${expectedPath}.`, true);
    });

    await step(`after: ${modelsIntent ? "requested model settings" : "the dashboard"} stay open on reload without extra setup steps`, async () => {
      await user.notSee({ testId: "onboarding-tools" });
      await user.notSee({ testId: "marketplace-onboarding" });
      await user.notSee({ text: "Back to setup" });
      await user.reload();
      await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
      await user.notSee({ text: "Back to setup" });
      await probe.eventually(() => world.pathname(), { within: 30_000, label: "requested destination", until: (path) => path === expectedPath });
      const connections = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable", { headers: scope() });
      expect(isRecord(connections.body) && connections.body.connections).toEqual([]);
      const models = await probe.api(world.den.admin, "/v1/inference", { headers: scope() });
      expect(isRecord(models.body) && isRecord(models.body.inference) && models.body.inference.enabled).toBe(false);
      await user.screenshot();
      evidence.recordAssertionEvidence("Finishing setup clears its continuation without enabling connections or paid models", `Reload stays on ${expectedPath}; no Back to setup, connections, or enabled paid models.`, true);
    });
  });
}
