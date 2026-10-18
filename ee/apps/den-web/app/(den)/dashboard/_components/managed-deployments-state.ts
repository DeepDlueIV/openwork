import { managedDeploymentReadinessMessage, type ManagedDeployment } from "@openwork/types/den/managed-deployments";

export type DeploymentTone = "neutral" | "warning" | "danger";
export type ProviderReadiness = {
  provider: "aws" | "gcp" | "azure";
  available: boolean;
  reason?: "ready" | "not_configured" | "invalid_configuration" | "not_supported" | "feature_disabled";
  missingFields?: string[];
};

export function providerName(provider: ProviderReadiness["provider"]) {
  return provider === "aws" ? "AWS" : provider === "gcp" ? "Google Cloud" : "Azure";
}

/** Configuration values and secrets never belong in readiness copy. */
export const readinessMessage = managedDeploymentReadinessMessage;

/** A configuration/rollout lock is a blocked state, not a failed cloud installation. */
export class DeploymentReadinessError extends Error {}

/** Race-safe fallback when a rollout or release changes after the form was opened. */
export function deploymentActionError(payload: unknown, provider: ProviderReadiness["provider"]): string | null {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return null;
  const reason = payload.error === "feature_disabled" ? "feature_disabled"
    : payload.error === "release_not_configured" ? "not_configured" : null;
  if (!reason) return null;
  if ("message" in payload && typeof payload.message === "string" && payload.message.trim() && payload.message !== payload.error) return payload.message;
  return readinessMessage({ provider, available: false, reason });
}

/** Installation/update failures take precedence over the last known health. */
export function deploymentStatus(deployment: ManagedDeployment): { label: string; tone: DeploymentTone } {
  const run = deployment.run;
  const installed = Boolean(deployment.installedVersion);
  if (run && run.state !== "ready") {
    if (run.expired) return { label: installed ? "Update stopped reporting" : "Installer stopped reporting", tone: "danger" };
    if (run.state === "failed") return { label: installed ? "Update failed" : "Install failed", tone: "danger" };
    if (run.state === "awaiting_approval") return { label: `Awaiting ${deployment.provider === "gcp" ? "Google Cloud" : "AWS"} approval`, tone: "neutral" };
    if (run.state === "provisioning") return { label: run.events.some((event) => event.step === "services_ready" && event.outcome === "succeeded") ? "Services started · checking health" : installed ? "Approved · updating" : "Approved · installing", tone: "neutral" };
  }
  if (!installed && !run) return { label: "Not launched", tone: "neutral" };
  switch (deployment.health.state) {
    case "operational": return { label: "Operational", tone: "neutral" };
    case "degraded": return { label: "Degraded", tone: "warning" };
    case "down": return { label: "Down", tone: "danger" };
    case "not_reporting": return { label: "Not reporting", tone: "warning" };
    case "awaiting_report": return { label: "Waiting for first report", tone: "neutral" };
  }
}
