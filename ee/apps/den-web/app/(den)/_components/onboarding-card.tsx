"use client";

import type { ReactNode } from "react";

export type OnboardingCardOrganization = {
  name: string;
};

export function OnboardingCard({
  organization,
  children,
}: {
  organization: OnboardingCardOrganization | null;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-8 rounded-[1.75rem] border border-slate-200/80 bg-white p-6 sm:p-8 md:p-10 sm:gap-10">
      <div className="flex min-w-0 items-center gap-2.5">
        <img src="/openwork-mark.svg" alt="" width={26} height={26} className="size-[26px] shrink-0 object-contain" aria-hidden="true" />
        <div className="min-w-0 text-[15px] font-semibold tracking-tight text-slate-950">
          <span>{organization?.name ?? "OpenWork Cloud"}</span>
        </div>
      </div>

      <div className="grid gap-5">
        {children}
      </div>
    </div>
  );
}
