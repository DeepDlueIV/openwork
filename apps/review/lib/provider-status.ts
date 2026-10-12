import { EVIDENCE_PROVIDER_LABELS, EVIDENCE_PROVIDERS, evidenceProviderFromEnv, type EvidenceProviderId } from "@openwork/evidence-provider";
import { freestyleConfigured } from "@openwork/freestyle/credentials";

/**
 * Credential checks only, so the report page does not load provider SDKs or
 * builders. Must agree with each provider's `configured()` in providers.ts.
 */
export const PROVIDER_CONFIGURED: Record<EvidenceProviderId, () => boolean> = {
  freestyle: freestyleConfigured,
  // Daytona has no review support yet.
  daytona: () => false,
};

/** The provider for new previews. A misconfigured setting shows as "not connected" instead of breaking the report. */
export function previewProviderStatus(): { label: string; connected: boolean } {
  try {
    const id = evidenceProviderFromEnv();
    return { label: EVIDENCE_PROVIDER_LABELS[id], connected: PROVIDER_CONFIGURED[id]() };
  } catch (error) {
    console.error("Review preview provider is misconfigured", { error: error instanceof Error ? error.message : "UnknownError" });
    return { label: "The preview provider", connected: false };
  }
}

/** Providers whose saved checkpoints this server can open. */
export function connectedCheckpointProviders(): EvidenceProviderId[] {
  return EVIDENCE_PROVIDERS.filter((id) => PROVIDER_CONFIGURED[id]());
}
