"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, type ReactNode } from "react";
import { ArrowLeft, Building2, ChartNoAxesCombined, Flag, LayoutDashboard, Users } from "lucide-react";

const SessionCookieContext = createContext(false);
export const useAdminSessionCookie = () => useContext(SessionCookieContext);

const SECTIONS = [
  { label: "Overview", href: "/admin", icon: LayoutDashboard },
  { label: "Users", href: "/admin/users", icon: Users },
  { label: "Organizations", href: "/admin/organizations", icon: Building2 },
  { label: "Feature rollouts", href: "/admin/features", icon: Flag },
  { label: "Free Auto usage", href: "/admin/free-auto", icon: ChartNoAxesCombined },
];

export function AdminShell({ hasSessionCookie, children }: { hasSessionCookie: boolean; children: ReactNode }) {
  const pathname = usePathname();
  return (
    <SessionCookieContext.Provider value={hasSessionCookie}>
      <div className="min-h-screen bg-slate-50">
        <a href="#admin-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:p-3">Skip to content</a>
        <aside className="flex flex-col border-b border-gray-200 bg-white md:fixed md:inset-y-0 md:w-56 md:overflow-y-auto md:border-b-0 md:border-r">
          <div className="shrink-0 px-5 py-5">
            <Link href="/admin" prefetch={false} className="text-sm font-semibold text-gray-900">OpenWork admin</Link>
          </div>
          <nav aria-label="Admin navigation" data-testid="admin-navigation" className="flex gap-1 overflow-x-auto px-3 pb-3 md:shrink-0 md:flex-col md:overflow-visible">
            {SECTIONS.map(({ label, href, icon: Icon }) => {
              const active = href === "/admin" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link key={href} href={href} prefetch={false} aria-current={active ? "page" : undefined}
                  className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 ${active ? "bg-slate-100 text-slate-950" : "text-slate-600 hover:bg-slate-50 hover:text-slate-950"}`}>
                  <Icon size={16} strokeWidth={1.5} aria-hidden="true" />{label}
                </Link>
              );
            })}
          </nav>
          <Link href="/" prefetch={false} className="flex shrink-0 items-center gap-2 px-6 py-4 text-sm text-slate-600 hover:text-slate-950 md:mt-auto">
            <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />Back to cloud panel
          </Link>
        </aside>
        <div className="md:pl-56">
          <main id="admin-content" className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">{children}</main>
        </div>
      </div>
    </SessionCookieContext.Provider>
  );
}
