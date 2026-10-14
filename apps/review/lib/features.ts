// Server-only rollout authority. Never forward the review request's credentials.
if (typeof window !== "undefined") throw new Error("Review feature authority is server-only.");

export type ReviewerDaytonaAuthorization = { enabled: true } | { enabled: false; reason: string };

type FeatureAuthorityOptions = {
  /** Trusted service configuration, never a report URL or browser input. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

const DEFAULT_DEN_API_BASE = "https://api.openworklabs.com";
const DISABLED = "Daytona previews are turned off. The deployment administrator can enable them in Features.";
const UNAVAILABLE = "Daytona preview availability could not be verified. Try again or contact the review app owner.";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The reviewer has no Den organization: only the deployment-wide public rollout
 * applies, not organization overrides. Missing, unavailable or invalid means off.
 * Check again for each new launch, poll and deferred build allocation. Killing
 * this rollout does not revoke existing previews or saved checkpoint access.
 *
 * No enabled result is retained here, including after a failed refresh. Den
 * returns no-store and uses its canonical revision-aware rollout cache (the
 * fallback TTL is 60 seconds if invalidation fails). Already-started allocations
 * are not cancelled; this is not a transaction with provider APIs.
 */
export async function reviewerDaytonaAuthorization(options: FeatureAuthorityOptions = {}): Promise<ReviewerDaytonaAuthorization> {
  try {
    const base = new URL(options.baseUrl ?? process.env.DEN_API_BASE ?? DEFAULT_DEN_API_BASE);
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      return { enabled: false, reason: UNAVAILABLE };
    }
    const response = await (options.fetch ?? globalThis.fetch)(new URL("/v1/features", base), {
      method: "GET",
      headers: { accept: "application/json", "cache-control": "no-cache" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!response.ok || !response.headers.get("cache-control")?.split(",").some((value) => value.trim().toLowerCase() === "no-store")) {
      // Older Den deployments/intermediaries must not authorize spend from a cached enabled answer.
      return { enabled: false, reason: UNAVAILABLE };
    }
    const payload: unknown = await response.json();
    if (!record(payload) || payload.version !== 1
      || (payload.deployment !== "cloud" && payload.deployment !== "self_hosted")
      || !record(payload.features) || !Object.values(payload.features).every((value) => typeof value === "boolean")) {
      return { enabled: false, reason: UNAVAILABLE };
    }
    if (payload.deployment !== "cloud" || payload.features.reviewerDaytonaPreviews !== true) {
      return { enabled: false, reason: DISABLED };
    }
    return { enabled: true };
  } catch {
    // Network errors and payloads can contain service URLs: never expose them.
    return { enabled: false, reason: UNAVAILABLE };
  }
}
