import { EVIDENCE_PROVIDER_LABELS, EVIDENCE_PROVIDERS, evidenceProviderFromEnv, type EvidenceProviderId } from "@openwork/evidence-provider";
import { daytonaConfigured } from "@openwork/daytona-evidence/credentials";
import { freestyleConfigured } from "@openwork/freestyle/credentials";

/**
 * Credential checks only, so the report page does not load provider SDKs or
 * builders. Must agree with each provider's `configured()` in providers.ts.
 */
export const PROVIDER_CONFIGURED: Record<EvidenceProviderId, () => boolean> = {
  freestyle: freestyleConfigured,
  daytona: daytonaConfigured,
};
/** Must agree with each provider's `supportsPreviews`. Daytona opens checkpoints only, for now. */
const SUPPORTS_PREVIEWS: Record<EvidenceProviderId, boolean> = { freestyle: true, daytona: false };

/** The provider for new previews. A misconfigured setting shows as "not connected" instead of breaking the report. */
export function previewProviderStatus(): { label: string; connected: boolean } {
  try {
    const id = evidenceProviderFromEnv();
    return { label: EVIDENCE_PROVIDER_LABELS[id], connected: SUPPORTS_PREVIEWS[id] && PROVIDER_CONFIGURED[id]() };
  } catch (error) {
    console.error("Review preview provider is misconfigured", { error: error instanceof Error ? error.message : "UnknownError" });
    return { label: "The preview provider", connected: false };
  }
}

/** Providers whose saved checkpoints this server can open. */
export function connectedCheckpointProviders(): EvidenceProviderId[] {
  return EVIDENCE_PROVIDERS.filter((id) => PROVIDER_CONFIGURED[id]());
}
