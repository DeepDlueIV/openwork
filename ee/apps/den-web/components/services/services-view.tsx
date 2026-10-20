"use client";

import { ChevronRight } from "lucide-react";
import { SERVICE_LABELS, SERVICE_REASON_LABELS, SERVICE_SETUP_HINTS, type DeploymentServiceStatus } from "@openwork/types/den/service-readiness";
import { DenBadge } from "../../app/(den)/_components/ui/badge";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenNotice } from "../../app/(den)/_components/ui/notice";
import { formatServiceTime } from "../../app/(den)/_lib/service-readiness";
import { serviceRows, serviceStateLabel, type ServicesViewState } from "./service-readiness-data";

function ServiceRow({ service }: { service: DeploymentServiceStatus }) {
  const tone = service.stale || service.state === "unknown" || service.state === "not_configured" || service.state === "ready" ? "neutral"
    : service.state === "unreachable" ? "danger" : "warning";
  return (
    <li data-testid={`service-status-${service.id}`} className="min-w-0 border-b border-[var(--dls-border)] py-3 last:border-b-0">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="text-sm font-medium text-[var(--dls-text-primary)]">{SERVICE_LABELS[service.id]}</h2>
          <span className="text-xs text-[var(--dls-text-secondary)]">{service.required ? "Required" : "Optional"}</span>
        </div>
        <span data-testid={`service-state-${service.id}`} className="flex w-32 max-w-full justify-end text-right">
          <DenBadge tone={tone} className="whitespace-normal">{serviceStateLabel(service)}</DenBadge>
        </span>
      </div>
      {service.state !== "ready" && service.state !== "not_configured" ? <p className="mt-1 text-xs text-[var(--dls-text-secondary)]">{SERVICE_REASON_LABELS[service.reason]}</p> : null}
      {service.stale || (service.state !== "ready" && service.lastSuccessAt) ? <p className="mt-1 text-xs text-[var(--dls-text-secondary)]">Last successful check: {formatServiceTime(service.lastSuccessAt)}</p> : null}
      <details data-testid={`service-details-${service.id}`} className="group mt-1 min-w-0 text-xs text-[var(--dls-text-secondary)]">
        <summary data-testid={`service-details-toggle-${service.id}`} className="flex w-fit cursor-pointer list-none items-center gap-1 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dls-text-primary)] [&::-webkit-details-marker]:hidden">
          <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />Technical details
        </summary>
        <dl className="mt-3 grid min-w-0 gap-2 pl-5 [overflow-wrap:anywhere]">
          <div><dt className="font-medium">Check scope</dt><dd>{SERVICE_REASON_LABELS[service.reason]}</dd></div>
          <div><dt className="font-medium">Setup requirements</dt><dd>{SERVICE_SETUP_HINTS[service.id]}</dd></div>
          <div><dt className="font-medium">Settings</dt><dd>{service.configured ? "Present" : "Incomplete or not set up"}</dd></div>
          <div><dt className="font-medium">Last checked</dt><dd>{formatServiceTime(service.checkedAt)}</dd></div>
          <div><dt className="font-medium">Last successful check</dt><dd>{formatServiceTime(service.lastSuccessAt)}</dd></div>
          {service.dependencies.length ? <div><dt className="font-medium">Dependencies</dt><dd>{service.dependencies.map((id) => SERVICE_LABELS[id]).join(", ")}</dd></div> : null}
          {service.missingSettings.length ? <div><dt className="font-medium">Missing setting names</dt><dd className="font-mono">{service.missingSettings.join(", ")}</dd></div> : null}
        </dl>
      </details>
    </li>
  );
}

export function ServicesView({ state, cooldown, checkNow, refresh, testId = "services-page" }: {
  state: ServicesViewState;
  cooldown: boolean;
  checkNow: () => void;
  refresh: () => void;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className="min-w-0 max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-lg font-semibold text-[var(--dls-text-primary)]">Services</h1>
        <DenButton data-testid="service-check-now" size="sm" disabled={state.pending || cooldown} aria-busy={state.pending} onClick={checkNow}>Check now</DenButton>
      </div>
      <p role="status" data-testid="services-check-progress" className="mt-3 min-h-5 text-xs text-[var(--dls-text-secondary)]">
        {state.pending ? "Checking services…" : `Last checked: ${formatServiceTime(state.snapshot?.checkedAt ?? null)}`}
      </p>
      {state.status === "error" ? (
        <div data-testid="services-check-error" className="mt-3">
          <DenNotice icon={null} message={state.message} action={<DenButton variant="secondary" size="sm" disabled={state.pending} onClick={refresh}>Retry</DenButton>} />
        </div>
      ) : null}
      <ul aria-label="Deployment services" className="mt-3 min-w-0 border-t border-[var(--dls-border)]">
        {serviceRows(state.snapshot).map((service) => <ServiceRow key={service.id} service={service} />)}
      </ul>
      <p className="mt-3 text-xs text-[var(--dls-text-secondary)]">Model completions and message delivery are not tested.</p>
    </section>
  );
}
