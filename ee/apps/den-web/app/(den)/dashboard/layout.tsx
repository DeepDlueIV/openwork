import { DenToastProvider } from "./_components/den-toast";
import { OrgDashboardShell } from "./_components/org-dashboard-shell";
import { OrgDashboardProvider } from "./_providers/org-dashboard-provider";
import { DashboardQueryClientProvider } from "./_providers/query-client-provider";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DashboardQueryClientProvider>
      <OrgDashboardProvider>
        <DenToastProvider>
          <OrgDashboardShell>{children}</OrgDashboardShell>
        </DenToastProvider>
      </OrgDashboardProvider>
    </DashboardQueryClientProvider>
  );
}
