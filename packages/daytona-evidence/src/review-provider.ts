import { notReadyReviewProvider, type ReviewPreviewProvider } from "@openwork/evidence-provider/review";
import { openDaytonaCheckpoint } from "./checkpoints.ts";
import { daytonaConfigured } from "./credentials.ts";

/**
 * Reviewer access on Daytona: opening saved checkpoints. Launching a fresh
 * preview of a commit is not supported yet, so those calls still refuse.
 */
export const daytonaReviewProvider: ReviewPreviewProvider = {
  ...notReadyReviewProvider("daytona"),
  configured: daytonaConfigured,
  openCheckpoint: ({ checkpoint, reportId, requestId }) => openDaytonaCheckpoint(checkpoint, reportId, requestId),
};
