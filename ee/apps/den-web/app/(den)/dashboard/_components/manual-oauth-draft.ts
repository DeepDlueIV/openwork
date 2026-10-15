export type ManualOAuthAddresses = { authorizationEndpoint: string; tokenEndpoint: string };
export type ManualOAuthField = keyof ManualOAuthAddresses;
export const EMPTY_OAUTH_ADDRESSES: ManualOAuthAddresses = { authorizationEndpoint: "", tokenEndpoint: "" };

export type ManualOAuthDraft = {
  values: ManualOAuthAddresses;
  published: { values: ManualOAuthAddresses; previous: ManualOAuthAddresses; inconsistent: boolean } | null;
};

export function manualOAuthDraft(values: ManualOAuthAddresses = EMPTY_OAUTH_ADDRESSES): ManualOAuthDraft {
  return { values: { ...values }, published: null };
}

/** Review is a reversible form edit, not authorization or a configuration write. */
export function reviewPublishedAddresses(draft: ManualOAuthDraft, values: ManualOAuthAddresses, inconsistent: boolean): ManualOAuthDraft {
  return { values: { ...values }, published: { values: { ...values }, previous: { ...draft.values }, inconsistent } };
}

export function undoPublishedAddresses(draft: ManualOAuthDraft): ManualOAuthDraft {
  return draft.published ? manualOAuthDraft(draft.published.previous) : draft;
}

export function publishedFieldUnsaved(draft: ManualOAuthDraft, field: ManualOAuthField, saved: ManualOAuthAddresses = EMPTY_OAUTH_ADDRESSES): boolean {
  return draft.published !== null && draft.values[field] === draft.published.values[field] && draft.values[field].trim() !== saved[field].trim();
}

export function publishedAddressesUnsaved(draft: ManualOAuthDraft, saved: ManualOAuthAddresses = EMPTY_OAUTH_ADDRESSES): boolean {
  return publishedFieldUnsaved(draft, "authorizationEndpoint", saved) || publishedFieldUnsaved(draft, "tokenEndpoint", saved);
}

export function oauthAddressHost(value: string): string {
  try { return new URL(value).host; } catch { return "the entered address"; }
}

export function manualOAuthDestination(url: string, values: ManualOAuthAddresses, hasClientSecret: boolean): { differentHost: boolean; message: string } {
  const mcpHost = oauthAddressHost(url);
  const authorizationHost = oauthAddressHost(values.authorizationEndpoint);
  const tokenHost = oauthAddressHost(values.tokenEndpoint);
  const differentHost = [values.authorizationEndpoint, values.tokenEndpoint].filter(Boolean).some((value) => oauthAddressHost(value) !== mcpHost);
  const recipient = `Your users' sign-in codes${hasClientSecret ? " and the client secret" : ""} will go to ${tokenHost}`;
  return {
    differentHost,
    message: differentHost
      ? `A different host from the MCP server (${mcpHost}): ${authorizationHost === tokenHost ? tokenHost : `${authorizationHost} (sign-in), ${tokenHost} (token)`}. ${recipient}.`
      : `${recipient} (same host as the MCP server).`,
  };
}
