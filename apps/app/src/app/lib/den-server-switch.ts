import { denOriginComparisonKey, resolveDenBaseUrls } from "./den";

export type DenServerSwitch = {
  currentHost: string;
  newHost: string;
};

function hostLabel(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

/**
 * Decides whether a sign-in link points at a different organization server
 * than the one this app is already set up for.
 *
 * Both sides are reduced to the server's web base URL (any `/api/den` proxy
 * suffix, trailing slash, host casing and loopback alias is ignored) and
 * compared by origin. The API origin is deliberately NOT compared: the
 * installed bootstrap stores the API origin the server published in its
 * runtime config, while a sign-in link carries only the web address, so the
 * two can differ for the very same server. Returns null when it is the same
 * server (no prompt needed) or either address cannot be read.
 */
export function resolveDenServerSwitch(input: {
  currentBaseUrl: string | null | undefined;
  linkBaseUrl: string | null | undefined;
}): DenServerSwitch | null {
  const currentBaseUrl = resolveDenBaseUrls(input.currentBaseUrl).baseUrl;
  const linkBaseUrl = resolveDenBaseUrls(input.linkBaseUrl).baseUrl;
  const currentOrigin = denOriginComparisonKey(currentBaseUrl);
  const linkOrigin = denOriginComparisonKey(linkBaseUrl);
  if (!currentOrigin || !linkOrigin || currentOrigin === linkOrigin) return null;

  return {
    currentHost: hostLabel(currentBaseUrl),
    newHost: hostLabel(linkBaseUrl),
  };
}
