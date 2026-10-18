import { allocateFreePorts } from "@openwork/cdp";
import { faultProxy, type Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/** Fixture publication coordinates are never fetched or executed. Only local target and handoff records are made. */
export async function deploymentReadinessRecovery(seed: Seed) {
  await using setup = new AsyncDisposableStack();
  const [api, web] = await allocateFreePorts(2);
  if (!api || !web) throw new Error("Missing isolated deployment ports");
  const faults = setup.use(await faultProxy({ apiUrl: `http://127.0.0.1:${api}`, webUrl: `http://127.0.0.1:${web}` }));
  const den = setup.use(await seed.den({
    ports: { api, web }, webApiBase: faults.ref.apiUrl, trustedOrigins: [faults.ref.webUrl],
    env: { DEN_DEPLOYMENT: "cloud", DEN_MANAGED_DEPLOYMENT_GCP_VERSION: "0.18.58",
      DEN_MANAGED_DEPLOYMENT_GCP_TEMPLATE_URL: "https://storage.googleapis.com/test-release/tutorial.md?generation=1",
      DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_URL: "https://storage.googleapis.com/test-release/bundle.tar.gz?generation=2",
      DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_SHA256: "a".repeat(64) },
    org: { name: "Deployment recovery", admin: { name: "Deployment owner" } },
  }));
  await enableOrganizationCapabilities(seed, den.admin, { managedDeployments: true, managedDeploymentsGcp: true });
  await faults.faults.status("/api/den/v1/managed-deployments", 404, { method: "POST", times: 1, body: { error: "feature_disabled" } });
  await faults.faults.status("/api/den/v1/managed-deployments", 503, { method: "POST", times: 1, body: { error: "release_not_configured" } });
  const browser = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/deployments", headless: true, viewport: { width: 1440, height: 1400 } });
  const owned = setup.move();
  return { den, web: browser, faults, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}
