import { cookies } from "next/headers";
import { AdminShell } from "../../components/admin/admin-shell";
import { AdminOverviewPage } from "../../components/admin/admin-overview-page";

export default async function AdminPage() {
  const cookieStore = await cookies();
  // A hint for the initial UI only. The admin endpoint still verifies the session
  // and allowlist before any dashboard data or controls are mounted.
  const hasSessionCookie = cookieStore.getAll().some(({ name, value }) =>
    Boolean(value) && /^(?:__Secure-)?(?:openwork-den|better-auth)\.session_token(?:\.\d+)?$/.test(name),
  );
  return (
    <AdminShell active="overview">
      <AdminOverviewPage hasSessionCookie={hasSessionCookie} />
    </AdminShell>
  );
}
