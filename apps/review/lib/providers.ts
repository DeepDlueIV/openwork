import { evidenceProviderFromEnv, type EvidenceProviderId } from "@openwork/evidence-provider";
import { notReadyReviewProvider, type ReviewPreviewProvider } from "@openwork/evidence-provider/review";
import { freestyleReviewProvider } from "@openwork/freestyle/review-provider";

const providers: Record<EvidenceProviderId, ReviewPreviewProvider> = {
  freestyle: freestyleReviewProvider,
  daytona: notReadyReviewProvider("daytona"),
};

/** A named provider, e.g. the one that saved a checkpoint. */
export function reviewProvider(id: EvidenceProviderId): ReviewPreviewProvider {
  return providers[id];
}

/** The provider for new previews, from OPENWORK_EVIDENCE_PROVIDER (unset means Freestyle). Throws when misconfigured. */
export function selectedReviewProvider(): ReviewPreviewProvider {
  return providers[evidenceProviderFromEnv()];
}
