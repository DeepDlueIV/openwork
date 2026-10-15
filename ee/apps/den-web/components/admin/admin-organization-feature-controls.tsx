"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { FEATURE_KEYS, FEATURES, type FeatureKey } from "@openwork/features";
import { DenButton } from "../../app/(den)/_components/ui/button";

export type AdminFeatureState = {
  enabled: boolean;
  source: "unavailable" | "killed" | "lock" | "override" | "everyone";
  everyone: boolean;
  killed: boolean;
  override: boolean | null;
  overrideApplies: boolean;
};
export type AdminOrganizationFeatures = Record<FeatureKey, AdminFeatureState>;

function describeSource(state: AdminFeatureState): string {
  switch (state.source) {
    case "everyone": return state.everyone ? "On for everyone" : "Off for everyone";
    case "override": return "Set for this organization";
    case "lock": return "Set by deployment config";
    case "killed": return "Turned off everywhere";
    case "unavailable": return "Not part of this deployment";
  }
}

/** Keep the registry-sized editor out of every organization row until opened. */
export function AdminOrganizationFeatureControls({ organizationId, features, loadFeatures, saving, error, onChange }: {
  organizationId: string;
  features: AdminOrganizationFeatures | null;
  loadFeatures: (organizationId: string, signal: AbortSignal) => Promise<void>;
  saving: boolean;
  error: string | null;
  onChange: (key: FeatureKey, enabled: boolean | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!expanded || features) return;
    const controller = new AbortController();
    setLoadError(null);
    void loadFeatures(organizationId, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Could not load features.");
    });
    return () => controller.abort();
  }, [expanded, features, organizationId, loadFeatures, attempt]);

  return (
    <details className="group mt-4 border-t border-slate-200 pt-4" data-testid="admin-organization-features" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary data-testid="admin-organization-features-toggle" className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={16} strokeWidth={1.5} className="transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
        Features
      </summary>
      {expanded && !features ? (
        loadError ? (
          <div className="mt-3 text-sm text-red-700" role="alert">
            <p>{loadError}</p>
            <DenButton variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>Retry features</DenButton>
          </div>
        ) : (
          <div className="mt-3 grid gap-2" role="status" aria-label="Loading organization features" data-testid="admin-features-loading">
            {[0, 1, 2].map((row) => <div key={row} className="h-10 rounded-lg bg-gray-100" aria-hidden="true" />)}
          </div>
        )
      ) : null}
      {expanded && features ? (
        <div>
          <a href="/admin/features" className="mt-3 inline-block text-xs font-medium text-slate-500 underline-offset-2 hover:underline">All features</a>
          <ul className="mt-2 grid gap-2">
            {FEATURE_KEYS.filter((key) => features[key].source !== "unavailable").map((key) => {
              const state = features[key];
              const definition = FEATURES[key];
              return (
                <li key={key} className="flex items-start gap-3">
                  <label className="flex min-w-0 flex-1 items-start gap-2">
                    <input type="checkbox" data-testid={`admin-capability-${key}`} checked={state.enabled}
                      disabled={!state.overrideApplies || saving} onChange={(event) => onChange(key, event.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border-slate-300" />
                    <span className="min-w-0">
                      <span className="text-sm text-slate-700">{definition.label}</span>
                      <span className="ml-2 text-xs text-slate-400" data-testid={`admin-capability-source-${key}`}>{describeSource(state)}</span>
                      <span className="block text-xs leading-5 text-slate-400">{definition.description}</span>
                    </span>
                  </label>
                  {state.source === "override" && state.overrideApplies ? (
                    <button type="button" data-testid={`admin-capability-reset-${key}`} disabled={saving} onClick={() => onChange(key, null)}
                      className="shrink-0 text-xs font-medium text-slate-500 underline-offset-2 hover:underline disabled:opacity-50">
                      Use everyone&apos;s setting
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {error ? <p data-testid="admin-capability-error" role="alert" className="mt-2 text-xs text-red-700">Save failed — the change was reverted. {error}</p> : null}
    </details>
  );
}
