"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { type McpRequirementsDiscovery, useDiscoverMcpConnectionRequirements } from "./mcp-connections-data";

export type ManualOAuthAddresses = { authorizationEndpoint: string; tokenEndpoint: string };
export const EMPTY_OAUTH_ADDRESSES: ManualOAuthAddresses = { authorizationEndpoint: "", tokenEndpoint: "" };

function host(value: string): string {
  try { return new URL(value).host; } catch { return "Invalid address"; }
}

/** Published addresses are suggestions only. Copying them still requires Save. */
export function ManualOAuthFields({ url, value, onChange, disabled = false, discovery }: {
  url: string;
  value: ManualOAuthAddresses;
  onChange: (value: ManualOAuthAddresses) => void;
  disabled?: boolean;
  discovery?: McpRequirementsDiscovery | null;
}) {
  const discover = useDiscoverMcpConnectionRequirements();
  const [preview, setPreview] = useState<McpRequirementsDiscovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const result = preview ?? discovery;
  const suggestions = dismissed ? [] : result?.publishedSignInAddresses ?? [];
  const mismatch = result?.warnings.find((warning) => warning.code === "oauth_issuer_mismatch");
  const differentHosts = [value.authorizationEndpoint, value.tokenEndpoint].filter(Boolean).some((endpoint) => host(endpoint) !== host(url));
  async function inspect() {
    setError(null);
    setDismissed(false);
    try {
      const result = await discover.mutateAsync(url);
      setPreview(result);
      if (!result.publishedSignInAddresses?.length) setError("This server did not publish usable sign-in addresses. Ask the server owner for the authorization and token URLs.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The sign-in addresses could not be read."); }
  }
  return <details className="group" open={suggestions.length > 0 || Boolean(value.authorizationEndpoint || value.tokenEndpoint)} data-testid="manual-oauth-settings">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-gray-600 [&::-webkit-details-marker]:hidden">
      <ChevronRight className="h-3.5 w-3.5 text-gray-600 transition-transform group-open:rotate-90" aria-hidden />
      Advanced sign-in settings
    </summary>
    <div className="mt-3 flex min-w-0 flex-col gap-3">
      {mismatch ? <p role="alert" className="break-words text-[13px] text-red-600">{mismatch.message}</p> : null}
      <DenButton type="button" variant="secondary" size="sm" disabled={disabled || !url} loading={discover.isPending} onClick={() => void inspect()}>Use addresses published by this server</DenButton>
      {suggestions.map((suggestion) => <div key={`${suggestion.authorizationEndpoint}\0${suggestion.tokenEndpoint}`} className="flex min-w-0 flex-col gap-2 border-y border-gray-100 py-3" data-testid="manual-oauth-prefill">
        <p className="text-[13px] text-gray-700">These addresses are published by the server, not verified by OpenWork. Your sign-in code and any client secret will be sent to the token address. Nothing is used until you save.</p>
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px] text-gray-600">
          <dt>MCP host</dt><dd className="break-all">{host(url)}</dd>
          <dt>Sign-in host</dt><dd className="break-all">{host(suggestion.authorizationEndpoint)}</dd>
          <dt>Authorization URL</dt><dd className="break-all">{suggestion.authorizationEndpoint}</dd>
          <dt>Token host</dt><dd className="break-all">{host(suggestion.tokenEndpoint)}</dd>
          <dt>Token URL</dt><dd className="break-all">{suggestion.tokenEndpoint}</dd>
        </dl>
        <DenButton type="button" size="sm" disabled={disabled} onClick={() => { onChange({ authorizationEndpoint: suggestion.authorizationEndpoint, tokenEndpoint: suggestion.tokenEndpoint }); setDismissed(true); }}>Confirm addresses in form</DenButton>
      </div>)}
      <label className="flex min-w-0 flex-col gap-1.5 text-[12px] font-medium text-gray-700">Authorization endpoint URL
        <DenInput type="url" value={value.authorizationEndpoint} disabled={disabled} placeholder="https://sign-in.example.com/authorize" onChange={(event) => onChange({ ...value, authorizationEndpoint: event.target.value })} data-testid="manual-oauth-authorization-endpoint" />
      </label>
      <label className="flex min-w-0 flex-col gap-1.5 text-[12px] font-medium text-gray-700">Token endpoint URL
        <DenInput type="url" value={value.tokenEndpoint} disabled={disabled} placeholder="https://sign-in.example.com/token" onChange={(event) => onChange({ ...value, tokenEndpoint: event.target.value })} data-testid="manual-oauth-token-endpoint" />
      </label>
      {Boolean(value.authorizationEndpoint) !== Boolean(value.tokenEndpoint) ? <p role="alert" className="text-[12px] text-red-600">Enter both addresses, or clear both to use automatic discovery.</p> : null}
      {differentHosts ? <p role="status" className="text-[12px] text-amber-700">The sign-in addresses use a different host from the MCP server ({host(url)}). Confirm that you trust {host(value.authorizationEndpoint)} and {host(value.tokenEndpoint)} before saving.</p> : null}
      {value.authorizationEndpoint && value.tokenEndpoint ? <p className="text-[12px] text-gray-500">Saving pins these exact addresses, skips sign-in discovery and signs everyone out. PKCE S256 is required. An OAuth client ID is required; its secret is optional.</p> : null}
      {error ? <p role="alert" className="text-[12px] text-red-600">{error}</p> : null}
    </div>
  </details>;
}
