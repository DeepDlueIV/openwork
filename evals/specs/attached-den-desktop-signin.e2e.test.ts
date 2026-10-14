import { expect } from "vitest";
import { SkipError, spec } from "@openwork/testkit";

// Proves a self-hosted Den that is already deployed (for example by one of the
// infra/terraform modules) accepts a desktop sign-in on its own public
// hostnames. Point it at the deployment and its first administrator:
//   OPENWORK_EVAL_DEN_WEB_URL=https://<web> OPENWORK_EVAL_DEMO_EMAIL=... \
//   OPENWORK_EVAL_DEMO_PASSWORD=... pnpm evals:e2e attached-den-desktop-signin --den https://<api>
// It creates nothing on the Den: no organization, member or invitation.
const test = spec.world(async (seed) => {
  if (!process.env.OPENWORK_EVAL_DEN_API_URL?.trim() || !process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim()) {
    throw new SkipError("OPENWORK_EVAL_DEN_API_URL and OPENWORK_EVAL_DEN_WEB_URL of a deployed Den, plus OPENWORK_EVAL_DEMO_EMAIL and OPENWORK_EVAL_DEMO_PASSWORD of its administrator");
  }
  const den = await seed.den();
  const app = await seed.desktop({ name: "attached-den-signin", den, as: "admin", workspace: false });
  return { den, app };
}, {
  resources: { surfaces: ["desktop"], services: ["den"], nativeReason: "The desktop's Den sign-in handoff and stored session live in the Electron app." },
  timeout: 600_000,
});

test("the desktop signs in to an already deployed Den on its public hostnames", async ({ world, probe, step }) => {
  const webUrl = world.den.ref.webUrl;
  const apiUrl = world.den.ref.apiUrl;

  const stored = await step("the desktop keeps a session issued by the deployment, and its organization", async () => {
    const state = await probe.eval(world.app, () => ({
      // The desktop records which control plane issued its session.
      sessionOrigin: localStorage.getItem("openwork.den.sessionOrigin"),
      token: localStorage.getItem("openwork.den.authToken") ?? "",
      orgId: localStorage.getItem("openwork.den.activeOrgId") ?? "",
    }));
    expect(state.sessionOrigin).toBe(new URL(webUrl).origin);
    expect(state.token.length).toBeGreaterThan(0);
    expect(state.orgId.length).toBeGreaterThan(0);
    return state;
  });

  await step("the deployment's public API accepts the desktop's session as the administrator", async () => {
    const response = await fetch(`${apiUrl}/v1/me`, { headers: { authorization: `Bearer ${stored.token}` }, signal: AbortSignal.timeout(15_000) });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ user: { email: world.den.admin.email } });
  });
});
