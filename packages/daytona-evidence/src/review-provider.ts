import { notReadyReviewProvider, type ReviewPreviewProvider } from "@openwork/evidence-provider/review";
import { openDaytonaCheckpoint } from "./checkpoints.ts";
import { daytonaConfigured } from "./credentials.ts";
import { daytonaFreshPreviewMethods } from "./previews.ts";

/**
 * Fresh direct app-web previews and unchanged saved-checkpoint access.
 * The review app owns the feature gate and exposes only DAYTONA_PREVIEW_WORLDS.
 */
export const daytonaReviewProvider: ReviewPreviewProvider = {
  ...notReadyReviewProvider("daytona"),
  configured: daytonaConfigured,
  supportsPreviews: true,
  ...daytonaFreshPreviewMethods(),
  openCheckpoint: ({ checkpoint, reportId, requestId }) => openDaytonaCheckpoint(checkpoint, reportId, requestId),
};
