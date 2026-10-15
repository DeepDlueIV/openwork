"use client";

import { ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { type McpRequirementsDiscovery, useDiscoverMcpConnectionRequirements } from "./mcp-connections-data";
import { EMPTY_OAUTH_ADDRESSES, manualOAuthDestination, publishedFieldUnsaved, reviewPublishedAddresses, undoPublishedAddresses, type ManualOAuthAddresses, type ManualOAuthDraft, type ManualOAuthField } from "./manual-oauth-draft";

function EndpointField({ field, label, draft, saved, disabled, onChange }: {
  field: ManualOAuthField;
  label: string;
  draft: ManualOAuthDraft;
  saved: ManualOAuthAddresses;
  disabled: boolean;
  onChange: (draft: ManualOAuthDraft) => void;
}) {
  const testId = field === "authorizationEndpoint" ? "manual-oauth-authorization-endpoint" : "manual-oauth-token-endpoint";
  return <label className="flex min-w-0 flex-col gap-1.5 text-[12px] font-medium text-[var(--dls-text-primary)]">
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {label}
      {publishedFieldUnsaved(draft, field, saved) ? <span data-testid={`${testId}-source`}>
        <DenBadge className="border border-[var(--dls-border)] !bg-transparent !px-2 !py-0 !text-[11px] !font-normal !text-[var(--dls-text-secondary)]">From server · not verified · not saved</DenBadge>
      </span> : null}
    </span>
    <DenInput type="url" value={draft.values[field]} disabled={disabled} className="font-mono !text-[13px] !font-normal" placeholder={field === "authorizationEndpoint" ? "https://sign-in.example.com/authorize" : "https://sign-in.example.com/token"} onChange={(event) => onChange({ ...draft, values: { ...draft.values, [field]: event.target.value } })} data-testid={testId} />
  </label>;
}

/** Reviewing published addresses only edits this draft. Save remains the trust boundary. */
export function ManualOAuthFields({ url, draft, onChange, saved = EMPTY_OAUTH_ADDRESSES, hasClientSecret = false, disabled = false, discovery }: {
  url: string;
  draft: ManualOAuthDraft;
  onChange: (draft: ManualOAuthDraft) => void;
  saved?: ManualOAuthAddresses;
  hasClientSecret?: boolean;
  disabled?: boolean;
  discovery?: McpRequirementsDiscovery | null;
}) {
  const discover = useDiscoverMcpConnectionRequirements();
  const [preview, setPreview] = useState<McpRequirementsDiscovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const result = preview ?? discovery;
  const mismatch = result?.warnings.some((warning) => warning.code === "oauth_issuer_mismatch") === true;
  const manuallyConfigured = Boolean(saved.authorizationEndpoint && saved.tokenEndpoint);
  const destination = manualOAuthDestination(url, draft.values, hasClientSecret);
  const pendingReview = draft.published !== null;

  async function inspect(): Promise<McpRequirementsDiscovery | null> {
    setError(null);
    try {
      const result = await discover.mutateAsync(url);
      setPreview(result);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sign-in addresses could not be read.");
      return null;
    }
  }

  async function review() {
    const source = result ?? await inspect();
    if (!source) return;
    const addresses = (source.publishedSignInAddresses ?? []).filter((entry, index, all) => all.findIndex((candidate) => candidate.authorizationEndpoint === entry.authorizationEndpoint && candidate.tokenEndpoint === entry.tokenEndpoint) === index);
    const address = addresses[0];
    if (!address || addresses.length !== 1) {
      setError(addresses.length > 1 ? "This server publishes more than one pair of sign-in addresses. Check with the server owner and enter the intended pair manually." : "This server did not publish usable sign-in addresses. Ask the server owner for the authorization and token URLs.");
      return;
    }
    setError(null);
    onChange(reviewPublishedAddresses(draft, { authorizationEndpoint: address.authorizationEndpoint, tokenEndpoint: address.tokenEndpoint }, source.warnings.some((warning) => warning.code === "oauth_issuer_mismatch")));
  }

  return <details className="group" open={Boolean(discovery?.warnings.some((warning) => warning.code === "oauth_issuer_mismatch")) || manuallyConfigured} data-testid="manual-oauth-settings" onToggle={(event) => {
    // Opening unconfigured sign-in settings may inspect public metadata. Saved
    // manual configurations never discover implicitly, even when this row opens.
    if (event.currentTarget.open && !result && !manuallyConfigured && !discover.isPending && !disabled) void inspect();
  }}>
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-[var(--dls-text-primary)] [&::-webkit-details-marker]:hidden">
      <ChevronRight className="h-3.5 w-3.5 text-[var(--dls-text-secondary)] transition-transform group-open:rotate-90" aria-hidden />
      Sign-in addresses
    </summary>
    <div className="mt-3 flex min-w-0 flex-col gap-4">
      {!pendingReview ? <>
        {mismatch ? <div className="flex flex-wrap items-start gap-3 border-y border-[var(--dls-border)] py-3" data-testid="manual-oauth-failure">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-[var(--ow-danger)]" aria-hidden />
          <div className="min-w-[230px] flex-1">
            <p role="alert" className="text-[13px] font-medium text-[var(--ow-danger)]">Sign-in stopped: this server's sign-in information is inconsistent</p>
            <p className="mt-1 text-[13px] leading-5 text-[var(--dls-text-secondary)]">OpenWork can't confirm which service should receive your users' sign-in codes, so it won't use the published addresses on its own. Check them with the server owner before using them.</p>
          </div>
          <DenButton type="button" variant="secondary" size="sm" disabled={disabled} loading={discover.isPending} onClick={() => void review()}>Review published addresses</DenButton>
        </div> : <div className="flex justify-start"><DenButton type="button" variant="secondary" size="sm" disabled={disabled || !url} loading={discover.isPending} onClick={() => void review()}>Review published addresses</DenButton></div>}
        {result?.publishedSignInAddresses?.length ? <details className="group/technical text-[12px] text-[var(--dls-text-secondary)]">
          <summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 transition-transform group-open/technical:rotate-90" aria-hidden />Technical details</summary>
          <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {result.publishedSignInAddresses.map((address, index) => <div key={index} className="contents">
              <dt>Named sign-in service</dt><dd className="break-all">{address.advertisedIssuer}</dd>
              <dt>Published issuer</dt><dd className="break-all">{address.metadataIssuer}</dd>
              <dt>Authorization URL</dt><dd className="break-all">{address.authorizationEndpoint}</dd>
              <dt>Token URL</dt><dd className="break-all">{address.tokenEndpoint}</dd>
            </div>)}
          </dl>
        </details> : null}
      </> : null}
      <EndpointField field="authorizationEndpoint" label="Authorization endpoint URL" draft={draft} saved={saved} disabled={disabled} onChange={onChange} />
      <EndpointField field="tokenEndpoint" label="Token endpoint URL" draft={draft} saved={saved} disabled={disabled} onChange={onChange} />
      {pendingReview || destination.differentHost ? <div role="status" className="rounded-lg bg-[color-mix(in_srgb,var(--ow-warning)_8%,var(--dls-surface))] px-3 py-2.5 text-[13px] leading-5 text-[var(--ow-warning)]" data-testid="manual-oauth-trust-warning">
        <p><TriangleAlert className="mr-1 inline size-3.5 align-text-bottom" aria-hidden /><span className="font-medium">{destination.message}</span></p>
        {pendingReview ? <p className="mt-1">
          {draft.published?.inconsistent ? "OpenWork didn't verify these addresses because the server's information is inconsistent. Save only if the server owner confirms them." : "OpenWork hasn't verified these addresses. Save only if the server owner confirms them."}{" "}
          <DenButton type="button" variant="plain" size="inline" className="!inline-flex !h-auto !p-0 !text-[var(--ow-warning)] underline underline-offset-2" disabled={disabled} onClick={() => onChange(undoPublishedAddresses(draft))}>Undo</DenButton>
        </p> : null}
      </div> : null}
      {Boolean(draft.values.authorizationEndpoint) !== Boolean(draft.values.tokenEndpoint) ? <p role="alert" className="text-[12px] text-[var(--ow-danger)]">Enter both addresses, or clear both to use automatic discovery.</p> : null}
      {error ? <p role="alert" className="text-[12px] text-[var(--ow-danger)]">{error}</p> : null}
    </div>
  </details>;
}
