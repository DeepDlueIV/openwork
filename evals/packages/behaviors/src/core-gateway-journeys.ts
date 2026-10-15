// Behaviors shared by the AI Gateway core journeys (evals/core): reading what
// a Gateway client or Den's public API returns. One file per promise group.

/** A JSON object from a Den or Gateway response, or {} when it is not one. */
export function gatewayRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** The objects in a JSON array from a Den or Gateway response. */
export function gatewayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(gatewayRecord) : [];
}

/** The error a Gateway client receives when a request is refused: code, message and details. */
export function gatewayErrorDetails(body: unknown) {
  const error = gatewayRecord(gatewayRecord(body).error);
  return { code: error.code, message: error.message, details: gatewayRecord(error.details) };
}

/** The providers in Den's GET /v1/inference-providers response. */
export function gatewayProviders(body: unknown): Record<string, unknown>[] {
  return gatewayRecords(gatewayRecord(body).inferenceProviders);
}

/** Who a provider is shared with: one audience object per access grant. */
export function gatewayAccessAudiences(provider: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return gatewayRecords(provider?.accessGrants).map((grant) => gatewayRecord(grant.audience)).filter((audience) => Object.keys(audience).length > 0);
}

/** A provider's first credential set (how its members authenticate), or {} when it has none. */
export function gatewayFirstCredentialSet(provider: Record<string, unknown> | undefined): Record<string, unknown> {
  return gatewayRecords(provider?.credentialSets)[0] ?? {};
}

type UsageBucket = { timeframe: string; usedMicroUsd: number };
type UsageStatus = { state: string; buckets: UsageBucket[]; providers?: { providerName: string; state: string; buckets: UsageBucket[] }[] | null };

/** What a member's own usage status says about the default limit and their first provider limit this month. */
export function gatewayUsageUsed(status: UsageStatus) {
  const provider = status.providers?.[0];
  return {
    defaultUsed: status.buckets.find((bucket) => bucket.timeframe === "month")?.usedMicroUsd ?? null,
    defaultState: status.state,
    providerName: provider?.providerName ?? null,
    providerUsed: provider?.buckets.find((bucket) => bucket.timeframe === "month")?.usedMicroUsd ?? null,
    providerState: provider?.state ?? null,
  };
}
